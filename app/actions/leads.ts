"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";
import { processLead } from "@/app/actions/process-lead";
import { inngest } from "@/inngest/client";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

export type LeadPatch = {
  full_name?: string | null;
  email?: string | null;
  niche?: string | null;
  bio?: string | null;
  external_link?: string | null;
  funnel_program_name?: string | null;
};

export async function updateLead(leadId: string, patch: LeadPatch): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  const clean: LeadPatch = {};
  for (const [k, v] of Object.entries(patch) as [keyof LeadPatch, string | null | undefined][]) {
    clean[k] = typeof v === "string" ? (v.trim() || null) : v ?? null;
  }
  const { error } = await sb.from("leads").update(clean).eq("id", leadId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  revalidatePath(`/leads`);
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
    .insert({ username, profile_url: profileUrl(username), status: "pending", crawl_depth: 0 })
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
  email?: string;
  followers?: string;
  bio?: string;
  niche?: string;
  youtube_url?: string;
  linkedin_url?: string;
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

export async function importLeadsFromCsv(rows: CsvImportRow[]): Promise<CsvImportResult> {
  await requireUser();
  if (!rows.length) return { ok: true, imported: 0, skipped: 0 };

  const sb = createAdminClient();

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
      email: row.email?.trim().toLowerCase() || null,
      email_status: row.email?.trim() ? "found" : null,
      followers: Number.isFinite(followers) ? followers : null,
      bio: row.bio?.trim() || null,
      niche: row.niche?.trim() || null,
      youtube_url: row.youtube_url?.trim() || null,
      linkedin_url: row.linkedin_url?.trim() || null,
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

// ─── Churn bucket actions ─────────────────────────────────────────────────────

export async function retryChurnEnrichment(
  limit = 50,
): Promise<{ ok: boolean; queued: number; ids: string[]; startedAt: string; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("leads")
    .select("id")
    .eq("status", "qualified")
    .is("email", null)
    .not("enriched_at", "is", null)
    .eq("outreach_count", 0)
    .order("overall_score", { ascending: false })
    .limit(limit);
  if (error) return { ok: false, queued: 0, ids: [], startedAt: "", error: error.message };
  const ids = (data ?? []).map((r) => r.id as string);
  if (!ids.length) return { ok: true, queued: 0, ids: [], startedAt: "" };
  const startedAt = new Date().toISOString();
  const { enrichLeadsBulk } = await import("@/app/actions/enrich");
  const result = await enrichLeadsBulk(ids);
  revalidatePath("/churn");
  return { ...result, ids, startedAt };
}

export async function getChurnRetryProgress(
  leadIds: string[],
  since: string,
): Promise<{ done: number; total: number; foundEmail: number }> {
  await requireUser();
  const sb = createAdminClient();
  const { data } = await sb
    .from("leads")
    .select("id, email, enriched_at")
    .in("id", leadIds)
    .gte("enriched_at", since);
  const done = (data ?? []).length;
  const foundEmail = (data ?? []).filter((r) => r.email).length;
  return { done, total: leadIds.length, foundEmail };
}

// Re-enrich funnel (program name) for all leads that have an email but no program name.
// Uses the free pipeline (raw fetch + domain parse) — safe to run even when ScrapingBee quota is exhausted.
export async function retryFunnelEnrichment(
  limit = 50,
): Promise<{ ok: boolean; queued: number; results: Array<{ username: string; program_name: string | null; error: string | null }> }> {
  await requireUser();
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("leads")
    .select("id, username, external_link")
    .eq("status", "qualified")
    .not("email", "is", null)
    .is("funnel_program_name", null)
    .not("external_link", "is", null)
    .order("overall_score", { ascending: false })
    .limit(limit);
  if (error) return { ok: false, queued: 0, results: [] };
  const rows = (data ?? []) as Array<{ id: string; username: string; external_link: string }>;
  if (!rows.length) return { ok: true, queued: 0, results: [] };

  const { enrichFunnelForLead } = await import("@/lib/funnel/enrich");

  const results: Array<{ username: string; program_name: string | null; error: string | null }> = [];
  for (const row of rows) {
    const r = await enrichFunnelForLead({ leadId: row.id, externalLink: row.external_link });
    results.push({ username: row.username, program_name: r.funnel_program_name, error: r.error });
  }

  revalidatePath("/leads");
  revalidatePath("/churn");
  return { ok: true, queued: rows.length, results };
}

// Fan out funnel enrichment events for ALL qualified leads with an external link,
// overwriting any existing program name. Use this after updating the LLM prompt.
export async function rerunFunnelForAllQualified(): Promise<{ ok: boolean; queued: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("leads")
    .select("id, external_link")
    .eq("status", "qualified")
    .not("external_link", "is", null);
  if (error) return { ok: false, queued: 0, error: error.message };
  const rows = (data ?? []) as Array<{ id: string; external_link: string }>;
  if (!rows.length) return { ok: true, queued: 0 };

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await inngest.send(
      chunk.map((r) => ({
        name: "lead/funnel.enrich.requested" as const,
        data: { lead_id: r.id, external_link: r.external_link },
      })),
    );
  }

  revalidatePath("/leads");
  return { ok: true, queued: rows.length };
}

// Fan out email enrichment for all qualified leads that currently have no email.
export async function reenrichLeadsWithoutEmail(): Promise<{ ok: boolean; queued: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data, error } = await sb
    .from("leads")
    .select("id")
    .eq("status", "qualified")
    .is("email", null);

  if (error) return { ok: false, queued: 0, error: error.message };
  const rows = (data ?? []) as Array<{ id: string }>;
  if (!rows.length) return { ok: true, queued: 0 };

  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await inngest.send(
      rows.slice(i, i + CHUNK).map((r) => ({
        name: "lead/email.enrich.requested" as const,
        data: { lead_id: r.id },
      })),
    );
  }

  revalidatePath("/leads");
  return { ok: true, queued: rows.length };
}

// Reset bounced leads and re-run the full email enrichment sequence on them.
// Clears email + email_status so the pipeline skip-guard won't bypass them,
// then fans out email.enrich.requested events via Inngest.
export async function reEnrichBouncedLeads(): Promise<{ ok: boolean; queued: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();

  const { data, error } = await sb
    .from("leads")
    .select("id")
    .eq("email_status", "bounced");

  if (error) return { ok: false, queued: 0, error: error.message };
  const rows = (data ?? []) as Array<{ id: string }>;
  if (!rows.length) return { ok: true, queued: 0 };

  const ids = rows.map((r) => r.id);

  // Clear the bounced email so the enrichment pipeline runs fresh.
  // Wipe enrichment_error too so the UI shows a clean slate while re-enriching.
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await sb
      .from("leads")
      .update({
        email: null,
        email_status: null,
        enriched_at: null,
        enrichment_error: null,
        outreach_count: 0,
        last_outreach_at: null,
        last_outreach_error: null,
      })
      .in("id", ids.slice(i, i + CHUNK));
  }

  for (let i = 0; i < ids.length; i += CHUNK) {
    await inngest.send(
      ids.slice(i, i + CHUNK).map((id) => ({
        name: "lead/email.enrich.requested" as const,
        data: { lead_id: id },
      })),
    );
  }

  revalidatePath("/leads");
  return { ok: true, queued: ids.length };
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

export async function getEnrichNoEmailProgress(): Promise<number> {
  await requireUser();
  const { count } = await createAdminClient()
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "qualified")
    .is("email", null);
  return count ?? 0;
}

export async function getEnrichBouncedProgress(since: string): Promise<number> {
  await requireUser();
  const { count } = await createAdminClient()
    .from("leads")
    .select("id", { count: "exact", head: true })
    .not("email", "is", null)
    .gte("enriched_at", since);
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

export async function recordManualOutreach(leadId: string): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { error } = await sb
    .from("leads")
    .update({ outreach_count: 1, last_outreach_at: new Date().toISOString() })
    .eq("id", leadId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/churn");
  return { ok: true };
}

export async function rejectLead(leadId: string): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { error } = await sb
    .from("leads")
    .update({ status: "rejected", rejection_reason: "manual_reject_churn" })
    .eq("id", leadId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/churn");
  revalidatePath("/leads");
  return { ok: true };
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
    { data: methodLog },
    { count: succeededCount },
    { count: blockedCount },
    { count: remainingCount },
    { count: recentUpdates },
    { count: pendingCount },
    { count: recentPendingUpdates },
    { count: recentFiveMin },
    { data: settingsRow },
  ] = await Promise.all([
    sb.from("crawl_logs")
      .select("detail")
      .in("action", ["backfill_metadata"])
      .gte("created_at", ONE_HOUR)
      .order("created_at", { ascending: false })
      .limit(1),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .not("followers", "is", null)
      .gte("updated_at", ONE_HOUR),
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
      .not("followers", "is", null)
      .gte("updated_at", NINETY_SEC),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .not("followers", "is", null),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .not("followers", "is", null)
      .gte("updated_at", NINETY_SEC),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .not("followers", "is", null)
      .gte("updated_at", FIVE_MIN),
    sb.from("app_settings").select("backfill_started_at").eq("id", 1).single(),
  ]);

  const startedAt = (settingsRow as { backfill_started_at?: string | null } | null)?.backfill_started_at ?? null;
  const startingUp = !!startedAt && startedAt >= TEN_MIN && (remainingCount ?? 0) > 0;

  const backfillRunning = ((recentUpdates ?? 0) > 0 || startingUp) && (remainingCount ?? 0) > 0;
  const analyzeRunning = (recentPendingUpdates ?? 0) > 0 && (pendingCount ?? 0) > 0;

  const succeeded = succeededCount ?? 0;
  const failed = blockedCount ?? 0;
  const method = methodLog?.[0]?.detail?.match(/mode=(\w+)/)?.[1] ?? null;
  const perMin = (recentFiveMin ?? 0) / 5;
  const total = succeeded + failed + (remainingCount ?? 0);
  const etaMin = backfillRunning && perMin > 0 ? Math.round((remainingCount ?? 0) / perMin) : null;

  let operation: OperationStatus["operation"] = null;
  if (backfillRunning) operation = "backfill";
  else if (analyzeRunning) operation = "analyze";
  else if (methodLog?.[0] && (remainingCount ?? 0) === 0) operation = "backfill";

  return {
    isRunning: backfillRunning || analyzeRunning,
    operation,
    method,
    succeeded,
    failed,
    remaining: remainingCount ?? 0,
    total,
    perMin,
    etaMin,
  };
}
