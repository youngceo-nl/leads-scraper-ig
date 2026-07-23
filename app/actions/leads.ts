"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";
import { processLead } from "@/app/actions/process-lead";
import { inngest } from "@/inngest/client";
import { getSettings } from "@/lib/config/settings";
import { hardFilter, metricsGate } from "@/lib/pipeline/filter";
import { computeMetrics } from "@/lib/pipeline/metrics";
import type { ScrapedProfile } from "@/lib/types";
import { isBadLeadCategory, type BadLeadCategory } from "@/lib/leads/bad-lead";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

const LEAD_STATUSES = ["qualified", "review", "rejected", "pending"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type LeadPatch = {
  full_name?: string | null;
  niche?: string | null;
  bio?: string | null;
  external_link?: string | null;
  status?: LeadStatus;
};

export async function updateLead(leadId: string, patch: LeadPatch): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  if (patch.status && !LEAD_STATUSES.includes(patch.status)) {
    return { ok: false, error: `Invalid status: ${patch.status}` };
  }
  const sb = createAdminClient();
  const clean: LeadPatch = {};
  for (const [k, v] of Object.entries(patch) as [keyof LeadPatch, string | null | undefined][]) {
    if (k === "status") { clean.status = v as LeadStatus; continue; }
    clean[k] = typeof v === "string" ? (v.trim() || null) : v ?? null;
  }
  const { error } = await sb.from("leads").update(clean).eq("id", leadId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  revalidatePath(`/leads`);
  return { ok: true };
}

/**
 * Human override for a lead the AI qualified but shouldn't have — a training
 * collection for docs/bottlenecks/bottleneck02.md ("stop allowing these leads
 * in"). Records the labeled example AND drops the lead from handover (it's no
 * longer worth paying Clay to find its email) by flipping status to rejected.
 * Does not touch excluded_usernames — a mislabel here shouldn't permanently
 * block the account from ever being re-scraped.
 */
export async function markBadLead(
  leadId: string,
  category: BadLeadCategory,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  if (!isBadLeadCategory(category)) return { ok: false, error: `Invalid category: ${category}` };

  const sb = createAdminClient();
  const { data: lead, error: loadErr } = await sb
    .from("leads")
    .select("username, status")
    .eq("id", leadId)
    .single();
  if (loadErr || !lead) return { ok: false, error: loadErr?.message ?? "Lead not found" };

  const { error: upsertErr } = await sb.from("rejected_leads").upsert({
    lead_id: leadId,
    username: lead.username,
    category,
    note: note?.trim() || null,
    prior_status: lead.status,
    marked_by: user.id,
  });
  if (upsertErr) return { ok: false, error: upsertErr.message };

  // Drop out of any open handover batch too — the handover pool query only
  // ever selects status='qualified', so this alone removes it, but clearing
  // handover_batch_id also frees it from a batch someone already claimed.
  const { error: updateErr } = await sb
    .from("leads")
    .update({ status: "rejected", handover_batch_id: null })
    .eq("id", leadId);
  if (updateErr) return { ok: false, error: updateErr.message };

  revalidatePath("/leads");
  return { ok: true };
}

/** Undo path from the Bad leads table — restores the lead to its pre-mark status. */
export async function unmarkBadLead(leadId: string): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data: row, error: loadErr } = await sb
    .from("rejected_leads")
    .select("prior_status")
    .eq("lead_id", leadId)
    .single();
  if (loadErr || !row) return { ok: false, error: loadErr?.message ?? "Not marked bad" };

  const { error: updateErr } = await sb
    .from("leads")
    .update({ status: (row.prior_status as LeadStatus) ?? "review" })
    .eq("id", leadId);
  if (updateErr) return { ok: false, error: updateErr.message };

  const { error: deleteErr } = await sb.from("rejected_leads").delete().eq("lead_id", leadId);
  if (deleteErr) return { ok: false, error: deleteErr.message };

  revalidatePath("/leads");
  return { ok: true };
}

export type AddLeadResult = {
  ok: boolean;
  error?: string;
  username?: string;
  already_existed?: boolean;
  analyzing?: boolean;
};

// Add a single lead by hand from the Leads page. We only need a username; the
// rest of the profile is filled in by the normal analyze pipeline. When
// `analyze` is on (the default) we kick that pipeline off immediately so a bare
// username turns into a scored lead without a second click.
export async function addLead(formData: FormData): Promise<AddLeadResult> {
  await requireUser();

  const raw = String(formData.get("input") ?? "").trim();
  if (!raw) return { ok: false, error: "Enter an Instagram username or profile URL." };

  const username = toUsername(raw);
  if (!username || !/^[a-z0-9._]{1,30}$/.test(username)) {
    return { ok: false, error: "That doesn't look like a valid Instagram username." };
  }

  const analyze = formData.get("analyze") === "on";
  const sb = createAdminClient();

  const { data: inserted, error } = await sb
    .from("leads")
    .insert({ username, profile_url: profileUrl(username), status: "pending", crawl_depth: 0, lead_source: "manual_ui" })
    .select("id")
    .single();

  if (error) {
    if (!/duplicate|unique/i.test(error.message)) return { ok: false, error: error.message };
    revalidatePath("/leads");
    return { ok: true, username, already_existed: true };
  }

  if (analyze && inserted?.id) {
    const res = await processLead(inserted.id as string);
    if (!res.ok) {
      // The lead is saved; only the analysis couldn't start. Don't fail the add.
      revalidatePath("/leads");
      return { ok: true, username, analyzing: false, error: `Added, but analysis couldn't start: ${res.error}` };
    }
  }

  revalidatePath("/leads");
  return { ok: true, username, analyzing: analyze };
}

// ─── CSV Import ──────────────────────────────────────────────────────────────

export type CsvImportRow = {
  username?: string;
  full_name?: string;
  followers?: string;
  bio?: string;
  niche?: string;
  profile_url?: string;
};

export type CsvImportResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  error?: string;
};

const IG_PROFILE_RE = /instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?/;

function resolveUsername(row: CsvImportRow): string | null {
  // Direct username field first
  const direct = row.username?.trim().replace(/^@/, "").toLowerCase();
  if (direct && /^[a-z0-9._]{1,30}$/.test(direct)) return direct;
  // Derive from profile_url
  const fromUrl = row.profile_url?.match(IG_PROFILE_RE)?.[1]?.toLowerCase();
  if (fromUrl) return fromUrl;
  return null;
}

export async function importLeadsFromCsv(
  rows: CsvImportRow[],
  mode: "insert" | "update" = "insert",
): Promise<CsvImportResult> {
  await requireUser();
  if (!rows.length) return { ok: true, imported: 0, skipped: 0 };

  const sb = createAdminClient();

  if (mode === "update") {
    // Re-import path for enriched data (e.g. Clay output): only touch leads
    // that already exist, and only overwrite fields actually present in the
    // row, so a partially-enriched CSV can't null out data we already have.
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const username = resolveUsername(row);
      if (!username) { skipped++; continue; }

      const patch: Record<string, unknown> = {};
      if (row.full_name?.trim()) patch.full_name = row.full_name.trim();
      if (row.bio?.trim()) patch.bio = row.bio.trim();
      if (row.niche?.trim()) patch.niche = row.niche.trim();
      const followers = row.followers ? parseInt(row.followers.replace(/[^0-9]/g, ""), 10) : null;
      if (Number.isFinite(followers)) patch.followers = followers;

      if (!Object.keys(patch).length) { skipped++; continue; }

      const { data, error } = await sb.from("leads").update(patch).eq("username", username).select("id");
      if (error) return { ok: false, imported: updated, skipped, error: error.message };
      if (data?.length) updated++; else skipped++;
    }
    revalidatePath("/leads");
    return { ok: true, imported: updated, skipped };
  }

  const inserts: object[] = [];
  let skipped = 0;

  for (const row of rows) {
    const username = resolveUsername(row);
    if (!username) { skipped++; continue; }

    const followers = row.followers ? parseInt(row.followers.replace(/[^0-9]/g, ""), 10) : null;

    inserts.push({
      username,
      profile_url: profileUrl(username),
      status: "pending",
      crawl_depth: 0,
      full_name: row.full_name?.trim() || null,
      followers: Number.isFinite(followers) ? followers : null,
      bio: row.bio?.trim() || null,
      niche: row.niche?.trim() || null,
    });
  }

  if (!inserts.length) return { ok: true, imported: 0, skipped };

  // ignoreDuplicates: silently skip rows whose username already exists.
  const { error } = await sb
    .from("leads")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(inserts as any[], { onConflict: "username", ignoreDuplicates: true });

  if (error) return { ok: false, imported: 0, skipped, error: error.message };

  revalidatePath("/leads");
  return { ok: true, imported: inserts.length, skipped };
}

// Fan out score events for all leads that have bio data, bypassing the
// skip guard. Useful after updating the scoring weights or AI prompt.
// Inngest handles concurrency (16 global, 8 per crawl_job).
export async function rescoreAllLeads(
  scope: "all" | "qualified_review" = "all",
): Promise<{ ok: boolean; queued: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  let q = sb
    .from("leads")
    .select("id")
    .not("bio", "is", null)
    .neq("status", "pending");

  if (scope === "qualified_review") {
    q = q.in("status", ["qualified", "review"]);
  }

  const { data, error } = await q;
  if (error) return { ok: false, queued: 0, error: error.message };
  const rows = (data ?? []) as Array<{ id: string }>;
  if (!rows.length) return { ok: true, queued: 0 };

  const { inngest } = await import("@/inngest/client");

  // Inngest accepts up to 512 events per send call.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await inngest.send(
      chunk.map((r) => ({
        name: "lead/score.requested" as const,
        data: { lead_id: r.id, force: true },
      })),
    );
  }

  revalidatePath("/leads");
  return { ok: true, queued: rows.length };
}

// Null out sub-scores and overall_score for all rejected leads.
// Used to backfill the "only good leads get a rating" behaviour after pipeline change.
export async function clearRejectedScores(): Promise<{ ok: boolean; cleared: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("leads")
    .update({
      overall_score: null,
      icp_fit_score: null,
      traction_score: null,
      monetization_score: null,
      activity_score: null,
    })
    .eq("status", "rejected")
    .not("overall_score", "is", null)
    .select("id");
  if (error) return { ok: false, cleared: 0, error: error.message };
  revalidatePath("/leads");
  return { ok: true, cleared: (data ?? []).length };
}

export async function getPendingCount(): Promise<number> {
  await requireUser();
  const { count } = await createAdminClient()
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .not("followers", "is", null);
  return count ?? 0;
}

// Count leads that still need backfill (followers IS NULL).
// Returns the remaining count so the activity drawer can compute done = total - remaining.
export async function getBackfillProgress(): Promise<number> {
  await requireUser();
  const { count } = await createAdminClient()
    .from("leads")
    .select("id", { count: "exact", head: true })
    .is("followers", null)
    .is("backfill_error", null)
    .neq("status", "rejected");
  return count ?? 0;
}

// Count how many leads were scored after `since` (ISO timestamp).
// Used by the rescore progress panel to show live progress.
export async function getRescoreProgress(since: string): Promise<{
  processed: number;
  qualified: number;
  review: number;
  rejected: number;
}> {
  await requireUser();
  const sb = createAdminClient();
  const { data } = await sb
    .from("leads")
    .select("status")
    .not("bio", "is", null)
    .in("status", ["qualified", "review", "rejected"])
    .gte("updated_at", since);
  const rows = (data ?? []) as Array<{ status: string }>;
  return {
    processed: rows.length,
    qualified: rows.filter((r) => r.status === "qualified").length,
    review:    rows.filter((r) => r.status === "review").length,
    rejected:  rows.filter((r) => r.status === "rejected").length,
  };
}

export type DeleteLeadsResult = { ok: boolean; deleted: number; error?: string };

// Bulk-delete leads by id. Before deleting, each lead's username is recorded in
// `excluded_usernames` so the crawler never re-adds it as a fresh duplicate.
export async function deleteLeads(ids: string[]): Promise<DeleteLeadsResult> {
  const user = await requireUser();
  const clean = [...new Set((ids ?? []).filter((id) => typeof id === "string" && id.length > 0))];
  if (clean.length === 0) return { ok: true, deleted: 0 };

  const sb = createAdminClient();

  // 1. Look up usernames so we can remember them on the exclusion list.
  const { data: rows, error: selErr } = await sb
    .from("leads")
    .select("id, username")
    .in("id", clean);
  if (selErr) return { ok: false, deleted: 0, error: selErr.message };

  const usernames = (rows ?? [])
    .map((r) => r.username)
    .filter((u): u is string => !!u);

  // 2. Record them as excluded (idempotent — ignore ones already listed).
  if (usernames.length) {
    const excludeRows = usernames.map((u) => ({
      username: u.toLowerCase(),
      reason: "bulk_delete",
      excluded_by: user.id,
    }));
    const { error: exErr } = await sb
      .from("excluded_usernames")
      .upsert(excludeRows, { onConflict: "username", ignoreDuplicates: true });
    if (exErr) return { ok: false, deleted: 0, error: exErr.message };
  }

  // 3. Delete the leads (lead_notes + outreach_messages cascade on FK).
  const { error: delErr, count } = await sb
    .from("leads")
    .delete({ count: "exact" })
    .in("id", clean);
  if (delErr) return { ok: false, deleted: 0, error: delErr.message };

  revalidatePath("/leads");
  return { ok: true, deleted: count ?? clean.length };
}

// ─── Bulk backfill ────────────────────────────────────────────────────────────

// Fan out backfill for all leads that still lack profile metadata.
// Splits into at most 3 parallel Inngest invocations so concurrent runs hit the
// global concurrency limit and progress in parallel without hammering IG.
export async function triggerBulkBackfill(): Promise<{ ok: boolean; queued: number; events: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data, error } = await sb
    .from("leads")
    .select("username")
    .is("followers", null)
    .or("backfill_error.is.null,backfill_error.eq.apify_exhausted")
    .neq("status", "rejected");

  if (error) return { ok: false, queued: 0, events: 0, error: error.message };
  const usernames = (data ?? []).map((r) => r.username).filter(Boolean);
  if (usernames.length === 0) return { ok: true, queued: 0, events: 0 };

  // Split into ≤3 chunks so Inngest can run them concurrently (concurrency limit: 3).
  const PARALLEL = 3;
  const chunkSize = Math.ceil(usernames.length / PARALLEL);
  const events: { name: "leads/backfill.metadata.requested"; data: { usernames: string[]; crawl_job_id: null; event_index: number } }[] = [];
  for (let i = 0; i < usernames.length; i += chunkSize) {
    events.push({
      name: "leads/backfill.metadata.requested",
      data: { usernames: usernames.slice(i, i + chunkSize), crawl_job_id: null, event_index: events.length },
    });
  }

  await Promise.all([
    inngest.send(events),
    sb.from("app_settings").update({ backfill_started_at: new Date().toISOString() }).eq("id", 1),
  ]);
  return { ok: true, queued: usernames.length, events: events.length };
}

/**
 * Backfill only the accounts on one seed's following list.
 *
 * Same event and chunking as triggerBulkBackfill, scoped by `parent_username`
 * so the Pipeline page drives one seed at a time. Deliberately not
 * `source_seed_id`: that also matches leads discovered by recursing into other
 * accounts, which are not this seed's followings.
 */
export async function triggerSeedBackfill(
  seed_id: string,
): Promise<{ ok: boolean; queued: number; events: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data: seed } = await sb.from("seeds").select("username").eq("id", seed_id).single();
  if (!seed) return { ok: false, queued: 0, events: 0, error: "seed_not_found" };

  const { data, error } = await sb
    .from("leads")
    .select("username")
    .eq("parent_username", seed.username)
    .is("followers", null)
    .or("backfill_error.is.null,backfill_error.eq.apify_exhausted")
    .neq("status", "rejected");

  if (error) return { ok: false, queued: 0, events: 0, error: error.message };
  const usernames = (data ?? []).map((r) => r.username).filter(Boolean);
  if (usernames.length === 0) return { ok: true, queued: 0, events: 0 };

  // Same 3-way split as the bulk path — Inngest runs backfill at concurrency 3.
  const PARALLEL = 3;
  const chunkSize = Math.ceil(usernames.length / PARALLEL);
  const events: { name: "leads/backfill.metadata.requested"; data: { usernames: string[]; crawl_job_id: null; event_index: number } }[] = [];
  for (let i = 0; i < usernames.length; i += chunkSize) {
    events.push({
      name: "leads/backfill.metadata.requested",
      data: { usernames: usernames.slice(i, i + chunkSize), crawl_job_id: null, event_index: events.length },
    });
  }

  await Promise.all([
    inngest.send(events),
    sb.from("app_settings").update({ backfill_started_at: new Date().toISOString() }).eq("id", 1),
  ]);
  return { ok: true, queued: usernames.length, events: events.length };
}

/** Runs a batch of Supabase writes with bounded concurrency instead of one huge Promise.all. */
async function runBatched<T>(items: T[], concurrency: number, fn: (item: T) => PromiseLike<unknown>) {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

/**
 * Pre-filters one seed's backfilled leads using the data backfill returned —
 * hardFilter + metricsGate, no AI. Purely local/CPU, so it runs synchronously
 * in the action rather than through Inngest.
 *
 * A lead that passes is stamped `hard_filter_passed_at` and otherwise left
 * alone (still 'pending') — that stamp is what makes it addressable by AI
 * Verify next. A lead that fails is rejected immediately with the same
 * reason/fields score-lead itself would write, so a manually pre-filtered
 * rejection is indistinguishable from an automatic one everywhere else in the
 * app (leads page, handover pool exclusion, etc).
 */
export async function triggerSeedFilter(
  seed_id: string,
): Promise<{ ok: boolean; passed: number; rejected: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data: seed } = await sb.from("seeds").select("username").eq("id", seed_id).single();
  if (!seed) return { ok: false, passed: 0, rejected: 0, error: "seed_not_found" };

  const { data: leads, error } = await sb
    .from("leads")
    .select(
      "id, username, full_name, profile_url, bio, external_link, followers, following, posts, is_private, is_verified, recent_posts",
    )
    .eq("parent_username", seed.username)
    .not("followers", "is", null)
    .eq("status", "pending")
    .is("hard_filter_passed_at", null);

  if (error) return { ok: false, passed: 0, rejected: 0, error: error.message };
  if (!leads?.length) return { ok: true, passed: 0, rejected: 0 };

  const settings = await getSettings();
  const now = new Date().toISOString();

  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  let passed = 0;
  let rejected = 0;

  for (const lead of leads) {
    const profile: ScrapedProfile = {
      username: lead.username,
      full_name: lead.full_name,
      profile_url: lead.profile_url,
      bio: lead.bio,
      external_link: lead.external_link,
      followers: lead.followers ?? 0,
      following: lead.following ?? 0,
      posts: lead.posts ?? 0,
      is_private: !!lead.is_private,
      is_verified: !!lead.is_verified,
      recent_posts: lead.recent_posts ?? [],
    };

    const hard = hardFilter(profile, settings);
    if (!hard.ok) {
      rejected++;
      // reason_for_score/recommended_action are cleared explicitly: this is a
      // narrow .update(), which only touches listed columns, so a lead that
      // went through AI on a previous pass and was later reset to 'pending'
      // would otherwise keep that stale verdict — making this rejection
      // misread as "already AI-verified" by the funnel's `verified` count.
      updates.push({
        id: lead.id,
        patch: { status: "rejected", rejection_reason: hard.reason, overall_score: null, reason_for_score: null, recommended_action: null },
      });
      continue;
    }

    const metrics = computeMetrics(profile);
    const reelSample = profile.recent_posts.filter((p) => p.is_reel).length;
    const mg = metricsGate(metrics, settings, reelSample);
    const metricFields = {
      avg_likes: metrics.avg_likes,
      avg_comments: metrics.avg_comments,
      avg_views: metrics.avg_views,
      engagement_rate: metrics.engagement_rate,
      posts_last_30_days: metrics.posts_last_30_days,
      reels_last_30_days: metrics.reels_last_30_days,
      activity_status: metrics.activity_status,
    };

    if (!mg.ok) {
      rejected++;
      // Same staleness fix as the hardFilter branch above.
      updates.push({
        id: lead.id,
        patch: {
          status: "rejected",
          rejection_reason: mg.reason,
          overall_score: null,
          reason_for_score: null,
          recommended_action: null,
          ...metricFields,
        },
      });
      continue;
    }

    passed++;
    updates.push({ id: lead.id, patch: { hard_filter_passed_at: now, ...metricFields } });
  }

  await runBatched(updates, 25, ({ id, patch }) => sb.from("leads").update(patch).eq("id", id));

  revalidatePath("/logs");
  return { ok: true, passed, rejected };
}

/**
 * AI-qualifies one seed's pre-filtered leads against the configured ICP —
 * fans out `lead/score.requested`, the same event backfill sends for every
 * newly-enriched lead. Scoped to leads that passed `triggerSeedFilter` and
 * haven't been scored yet, so this never re-litigates a past rejection or
 * re-spends AI credits on a lead already verified.
 */
export async function triggerSeedVerify(
  seed_id: string,
): Promise<{ ok: boolean; queued: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data: seed } = await sb.from("seeds").select("username").eq("id", seed_id).single();
  if (!seed) return { ok: false, queued: 0, error: "seed_not_found" };

  const { data: leads, error } = await sb
    .from("leads")
    .select("id")
    .eq("parent_username", seed.username)
    .not("hard_filter_passed_at", "is", null)
    .eq("status", "pending");

  if (error) return { ok: false, queued: 0, error: error.message };
  if (!leads?.length) return { ok: true, queued: 0 };

  await inngest.send(
    leads.map((lead) => ({
      name: "lead/score.requested" as const,
      data: { lead_id: lead.id, crawl_job_id: null },
    })),
  );

  revalidatePath("/logs");
  return { ok: true, queued: leads.length };
}

export async function getPipelineStats(): Promise<{
  byStatus: Record<string, number>;
  byBlockReason: Record<string, number>;
}> {
  await requireUser();
  const sb = createAdminClient();

  const [{ data: statuses }, { data: blocked }] = await Promise.all([
    sb.from("leads").select("status"),
    sb.from("leads").select("backfill_error").not("backfill_error", "is", null),
  ]);

  const byStatus: Record<string, number> = {};
  for (const r of statuses ?? []) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  const byBlockReason: Record<string, number> = {};
  for (const r of blocked ?? []) {
    const key = r.backfill_error as string;
    byBlockReason[key] = (byBlockReason[key] ?? 0) + 1;
  }

  return { byStatus, byBlockReason };
}

export async function resetApifyExhausted(): Promise<{ ok: boolean; reset: number }> {
  await requireUser();
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("leads")
    .update({ backfill_error: null })
    .eq("backfill_error", "apify_exhausted")
    .is("followers", null)
    .select("id");
  if (error) return { ok: false, reset: 0 };
  revalidatePath("/logs");
  return { ok: true, reset: data?.length ?? 0 };
}

export async function resetBlocked(): Promise<{ ok: boolean; reset: number }> {
  await requireUser();
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("leads")
    .update({ backfill_error: null })
    .eq("backfill_error", "blocked")
    .is("followers", null)
    .select("id");
  if (error) return { ok: false, reset: 0 };
  revalidatePath("/logs");
  return { ok: true, reset: data?.length ?? 0 };
}

export async function cancelBackfill(): Promise<void> {
  await requireUser();
  const sb = createAdminClient();
  await sb.from("app_settings").update({ backfill_cancel_requested: true }).eq("id", 1);
}

export async function dismissStalledBackfill(): Promise<void> {
  await requireUser();
  const sb = createAdminClient();
  await sb.from("app_settings").update({ backfill_started_at: null }).eq("id", 1);
}

export type OperationStatus = {
  isRunning: boolean;
  operation: "backfill" | "analyze" | "crawl" | null;
  method: string | null;
  succeeded: number;
  failed: number;
  remaining: number;
  total: number;
  perMin: number;
  etaMin: number | null;
};

export async function getOperationStatus(): Promise<OperationStatus> {
  const sb = createAdminClient();
  const ONE_HOUR = new Date(Date.now() - 60 * 60_000).toISOString();
  const NINETY_SEC = new Date(Date.now() - 90_000).toISOString();
  const TEN_MIN = new Date(Date.now() - 10 * 60_000).toISOString();
  const FIVE_MIN = new Date(Date.now() - 5 * 60_000).toISOString();

  const [
    { data: backfillLogs },
    { count: blockedCount },
    { count: remainingCount },
    { count: pendingCount },
    { count: recentPendingUpdates },
    { data: settingsRow },
    { data: analyzeJobs },
  ] = await Promise.all([
    // Key signal for backfill: the crawl_log it writes at completion, not lead.updated_at
    // (lead.updated_at fires on email enrichment, follow-ups, etc. — too noisy)
    sb.from("crawl_logs")
      .select("detail, created_at")
      .eq("action", "backfill_metadata")
      .gte("created_at", ONE_HOUR)
      .order("created_at", { ascending: false })
      .limit(1),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .not("backfill_error", "is", null)
      .not("backfill_error", "eq", "apify_exhausted")
      .gte("updated_at", ONE_HOUR),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .is("followers", null)
      .or("backfill_error.is.null,backfill_error.eq.apify_exhausted"),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .not("followers", "is", null),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .not("followers", "is", null)
      .gte("updated_at", NINETY_SEC),
    sb.from("app_settings").select("backfill_started_at").eq("id", 1).single(),
    sb.from("crawl_jobs")
      .select("id, expected_profiles, profiles_scraped, qualified_count, rejected_count, status, finished_at")
      .is("seed_id", null)
      .gte("started_at", ONE_HOUR)
      .order("started_at", { ascending: false })
      .limit(5),
  ]);

  const analyzeJob = (analyzeJobs ?? [])[0] ?? null;

  const startedAt = (settingsRow as { backfill_started_at?: string | null } | null)?.backfill_started_at ?? null;
  // backfill_started_at is set when triggered, cleared when done/cancelled — authoritative active signal
  const startingUp = !!startedAt && startedAt >= TEN_MIN && (remainingCount ?? 0) > 0;
  // A completion log in the last 5 min means the batch just finished (still want to show card)
  const recentLog = backfillLogs?.[0] ?? null;
  const justFinished = !!recentLog && recentLog.created_at >= FIVE_MIN;
  const backfillRunning = (startingUp || justFinished) && (remainingCount ?? 0) > 0;

  // Recent-update + backlog alone isn't enough: triggerSeedFilter also leaves
  // passed leads `status = 'pending'` with a fresh `updated_at`, which looks
  // identical to analyze-in-progress. Require an actual analyze job (the
  // crawl_jobs row analyzeAllPending creates) to exist, so a Filter click
  // against unrelated backlog elsewhere can't paint this as "running".
  const analyzeRunning = !!analyzeJob && (recentPendingUpdates ?? 0) > 0 && (pendingCount ?? 0) > 0;

  let operation: OperationStatus["operation"] = null;
  if (backfillRunning || startingUp) operation = "backfill";
  else if (analyzeRunning) operation = "analyze";
  else if (recentLog && (remainingCount ?? 0) === 0) operation = "backfill";

  let succeeded: number;
  let failed: number;
  let remaining: number;
  let total: number;
  let method: string | null;

  const perMin = 0;
  const etaMin: number | null = null;

  if (operation === "analyze") {
    // Each lead the batch touches writes exactly one row: a crawl_log entry
    // on normal completion (scored or filtered out), or an error_log entry
    // if it threw (e.g. the AI provider is down/out of quota) and got stuck
    // in "pending". Neither of those come from backfill's signals.
    const [{ count: processedCount }, { count: erroredCount }] = analyzeJob
      ? await Promise.all([
          sb.from("crawl_logs")
            .select("*", { count: "exact", head: true })
            .eq("crawl_job_id", analyzeJob.id)
            .in("action", ["scored", "filtered_hard", "filtered_metrics"]),
          sb.from("error_logs")
            .select("*", { count: "exact", head: true })
            .eq("crawl_job_id", analyzeJob.id),
        ])
      : [{ count: 0 }, { count: 0 }];

    succeeded = processedCount ?? 0;
    failed = erroredCount ?? 0;
    total = analyzeJob?.expected_profiles ?? pendingCount ?? 0;
    remaining = Math.max(total - succeeded - failed, 0);
    method = null;
  } else {
    // Parse succeeded/method from the summary log written at batch end
    succeeded = parseInt(recentLog?.detail?.match(/updated=(\d+)/)?.[1] ?? "0", 10);
    failed = blockedCount ?? 0;
    method = recentLog?.detail?.match(/mode=(\w+)/)?.[1] ?? null;
    remaining = remainingCount ?? 0;
    total = succeeded + failed + remaining;
  }

  return {
    isRunning: backfillRunning || analyzeRunning,
    operation,
    method,
    succeeded,
    failed,
    remaining,
    total,
    perMin,
    etaMin,
  };
}
