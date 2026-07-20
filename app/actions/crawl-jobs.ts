"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { inngest } from "@/inngest/client";
import { hasBeenScraped, checkRescrapeOverride } from "@/lib/seeds/scraped";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

export type ScrapeRun = {
  id: string;
  seedUsername: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  /** Accounts pulled off the following list (0 until the first page lands). */
  scraped: number;
  found: number;
  backfilled: number;
  filtered: number;
  verified: number;
  duplicates: number;
  excluded: number;
  /**
   * True for runs that finished before the funnel counters existed. Their
   * backfilled/filtered/verified numbers were never recorded, so the UI shows
   * "—" rather than 0 — a zero here would claim nothing was enriched.
   */
  legacy: boolean;
};

/**
 * A seed's whole pipeline, as it stands right now — not one run's counters.
 *
 * `found` is the hard ceiling (the account's own follow count, refreshed at
 * scrape time — see `seeds.following_count`). `duplicates`/`excluded` are
 * summed across every run that recorded them; `null` means none of this
 * seed's runs ever did (they predate the counters), which reads as "—" rather
 * than a false "0". `new` onward are current lead-table state, so they can
 * never regress to a dash the way a run-scoped counter would for old runs.
 */
export type SeedFunnel = {
  found: number | null;
  /** Accounts actually pulled off the following list, across all runs — distinct from `found`, the ceiling. */
  scraped: number;
  duplicates: number | null;
  excluded: number | null;
  new: number;
  backfilled: number;
  /** Backfilled leads the hardFilter/metricsGate already rejected — never touches `filtered`. */
  rejected: number;
  filtered: number;
  verified: number;
};

export type SeedPipeline = {
  seedId: string;
  username: string;
  runs: ScrapeRun[];
  succeeded: number;
  failed: number;
  funnel: SeedFunnel;
  /** Leads this seed's crawls produced that still lack metadata. */
  needsBackfill: number;
  /** Backfilled, pending, never checked by hardFilter/metricsGate. */
  needsFilter: number;
  /** Passed the pre-filter, pending, never AI-scored. */
  needsVerify: number;
  /** All leads this seed's crawls produced — the denominator for needsBackfill. */
  totalLeads: number;
  /** True while any of this seed's runs is queued or running. */
  busy: boolean;
};

/**
 * The pipeline grouped by seed account — one entry per seed that has ever run.
 *
 * Counts are scoped by `parent_username` — the accounts that are actually on
 * this seed's following list. `source_seed_id` would also sweep in leads found
 * by recursing into *other* accounts (it credited @pierree with 1039 when only
 * 462 are his), which is the same mis-attribution already fixed in handover and
 * the leads Source badge.
 */
export async function getSeedPipelines(): Promise<SeedPipeline[]> {
  await requireUser();
  const sb = createAdminClient();

  const [{ data: seeds }, { data: jobs }, { data: counts }] = await Promise.all([
    sb.from("seeds").select("id, username, following_count"),
    sb
      .from("crawl_jobs")
      .select(
        "id, seed_id, status, started_at, finished_at, error_message, profiles_scraped, new_leads, accounts_found, accounts_backfilled, accounts_filtered, accounts_verified, accounts_duplicate, accounts_excluded, created_at",
      )
      .order("created_at", { ascending: false }),
    // Aggregated server-side. Counting these in JS meant selecting every lead
    // row, which PostgREST truncates at 1000 — counts for anything past that
    // page silently came back as 0.
    sb.rpc("lead_counts_by_parent"),
  ]);

  const nameById = new Map((seeds ?? []).map((s) => [s.id, s.username]));
  const followingCountByName = new Map((seeds ?? []).map((s) => [s.username, s.following_count as number | null]));

  // Keyed by username, since parent_username is a handle not a seed id.
  type CountRow = {
    parent_username: string;
    total: number;
    pending_backfill: number;
    backfilled: number;
    filtered: number;
    verified: number;
    needs_filter: number;
    needs_verify: number;
    rejected: number;
  };
  const byParent = new Map<string, CountRow>(
    ((counts ?? []) as CountRow[]).map((r) => [r.parent_username, r]),
  );

  const runsBySeed = new Map<string, ScrapeRun[]>();
  for (const j of jobs ?? []) {
    if (!j.seed_id) continue;
    const found = j.accounts_found ?? 0;
    const backfilled = j.accounts_backfilled ?? 0;
    const filtered = j.accounts_filtered ?? 0;
    const verified = j.accounts_verified ?? 0;
    const duplicates = j.accounts_duplicate ?? 0;
    const excluded = j.accounts_excluded ?? 0;
    // Every scraped item lands in exactly one of found/duplicate/excluded (see
    // bulkUpsertDiscoveredLeads), so under current code those three always sum
    // to profiles_scraped. If profiles were scraped but all three read 0, that
    // sum is impossible to produce honestly — the run predates counter
    // tracking. (The previous check used `new_leads > 0` as the signal, which
    // missed every legacy run that happened to find zero new leads — e.g. a
    // 500-account rescrape where all 500 were duplicates showed "0 duplicates"
    // instead of "—", because that run's duplicate count was never recorded.)
    const scraped = j.profiles_scraped ?? 0;
    const legacy = scraped > 0 && found + duplicates + excluded === 0;

    const run: ScrapeRun = {
      id: j.id,
      seedUsername: nameById.get(j.seed_id) ?? "unknown",
      status: j.status,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
      errorMessage: j.error_message,
      scraped,
      found: legacy ? (j.new_leads ?? 0) : found,
      backfilled,
      filtered,
      verified,
      legacy,
      duplicates,
      excluded,
    };
    const list = runsBySeed.get(j.seed_id);
    if (list) list.push(run);
    else runsBySeed.set(j.seed_id, [run]);
  }

  return [...runsBySeed.entries()]
    .map(([seedId, runs]) => {
      const username = nameById.get(seedId) ?? "unknown";
      const counts = byParent.get(username);

      // Sum only what non-legacy runs recorded. Gated on actual scraped
      // volume, not just "a non-legacy run exists": a run that measured 0
      // duplicates because it scraped 0 profiles (e.g. cancelled instantly)
      // is real data, but summing only runs like that produces a "0" that
      // says nothing about however many profiles the seed's *other* (legacy)
      // runs actually scraped — technically honest, practically misleading.
      const measurableRuns = runs.filter((r) => !r.legacy);
      const measuredVolume = measurableRuns.reduce((sum, r) => sum + r.scraped, 0);
      const duplicates = measuredVolume > 0
        ? measurableRuns.reduce((sum, r) => sum + r.duplicates, 0)
        : null;
      const excluded = measuredVolume > 0
        ? measurableRuns.reduce((sum, r) => sum + r.excluded, 0)
        : null;
      // profiles_scraped has existed since the original schema, so every run
      // (legacy or not) reports it honestly — no measurableRuns gate needed.
      const scraped = runs.reduce((sum, r) => sum + r.scraped, 0);

      return {
        seedId,
        username,
        runs,
        succeeded: runs.filter((r) => r.status === "completed").length,
        failed: runs.filter((r) => r.status === "failed" || r.status === "cancelled").length,
        funnel: {
          found: followingCountByName.get(username) ?? null,
          scraped,
          duplicates,
          excluded,
          new: counts?.total ?? 0,
          backfilled: counts?.backfilled ?? 0,
          rejected: counts?.rejected ?? 0,
          filtered: counts?.filtered ?? 0,
          verified: counts?.verified ?? 0,
        },
        needsBackfill: counts?.pending_backfill ?? 0,
        needsFilter: counts?.needs_filter ?? 0,
        needsVerify: counts?.needs_verify ?? 0,
        totalLeads: counts?.total ?? 0,
        busy: runs.some((r) => r.status === "running" || r.status === "queued"),
      };
    })
    .sort((a, b) => {
      // Anything running floats to the top; then most recently active.
      if (a.busy !== b.busy) return a.busy ? -1 : 1;
      return (b.runs[0]?.startedAt ?? "").localeCompare(a.runs[0]?.startedAt ?? "");
    });
}

export async function getCrawlJobProgress(job_id: string): Promise<{ scraped: number; total: number; status: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { data } = await sb
    .from("crawl_jobs")
    .select("profiles_scraped, expected_profiles, status")
    .eq("id", job_id)
    .single();
  return {
    scraped: data?.profiles_scraped ?? 0,
    total: data?.expected_profiles ?? 0,
    status: data?.status ?? "unknown",
  };
}

export type ActiveJob = {
  id: string;
  type: "crawl" | "backfill";
  label: string;
  status: string;
  scraped: number;
  total: number;
  startedAt: string | null;
  stalled?: boolean;
};

export async function getActiveJobs(): Promise<ActiveJob[]> {
  await requireUser();
  const sb = createAdminClient();

  const TEN_MIN = new Date(Date.now() - 10 * 60_000).toISOString();

  const settingsRes = await sb.from("app_settings").select("backfill_started_at").eq("id", 1).single();
  const startedAt = (settingsRes.data as { backfill_started_at?: string | null } | null)?.backfill_started_at ?? null;

  const [{ data: crawlJobs }, { count: backfillRemaining }, { count: recentUpdates }, { count: backfillDone }] = await Promise.all([
    sb.from("crawl_jobs")
      .select("id, status, profiles_scraped, expected_profiles, started_at, seeds(username)")
      .in("status", ["queued", "running"])
      .order("started_at", { ascending: false })
      .limit(5),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .is("followers", null)
      .or("backfill_error.is.null,backfill_error.eq.apify_exhausted")
      .neq("status", "rejected"),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .not("followers", "is", null)
      .gte("updated_at", new Date(Date.now() - 90_000).toISOString()),
    startedAt
      ? sb.from("leads")
          .select("*", { count: "exact", head: true })
          .not("followers", "is", null)
          .gte("updated_at", startedAt)
          .neq("status", "rejected")
      : Promise.resolve({ count: 0 }),
  ]);

  // The provider each running job actually used, read from its own log lines.
  // This used to be inferred as "Playwright" from "0 scraped and still
  // running", which mislabelled every Apify crawl — Apify returns its whole
  // list in one call, so it sits at 0 for the entire run.
  const runningIds = (crawlJobs ?? []).map((j) => j.id);
  const providerByJob = new Map<string, string>();
  if (runningIds.length) {
    const { data: providerLogs } = await sb
      .from("crawl_logs")
      .select("crawl_job_id, detail")
      .in("crawl_job_id", runningIds)
      .eq("action", "scraped_following")
      .order("created_at", { ascending: false });
    for (const log of providerLogs ?? []) {
      if (!log.crawl_job_id || providerByJob.has(log.crawl_job_id)) continue;
      const match = /provider=(\w+)/.exec(log.detail ?? "");
      if (match) providerByJob.set(log.crawl_job_id, match[1]);
    }
  }

  const jobs: ActiveJob[] = [];

  for (const j of crawlJobs ?? []) {
    const seed = (j.seeds as unknown as { username: string } | null);
    const scraped = j.profiles_scraped ?? 0;
    const total = j.expected_profiles ?? 0;
    // Unnamed until a page has actually reported one — claiming a provider we
    // haven't observed is what caused this bug in the first place.
    const provider = providerByJob.get(j.id);
    jobs.push({
      id: j.id,
      type: "crawl",
      label: provider
        ? `Scraping @${seed?.username ?? "account"} with ${provider}…`
        : `Scraping @${seed?.username ?? "account"}…`,
      status: j.status,
      scraped,
      total,
      startedAt: j.started_at ?? null,
    });
  }

  const startingUp = !!startedAt && startedAt >= TEN_MIN && (backfillRemaining ?? 0) > 0;
  const hasRecentActivity = (recentUpdates ?? 0) > 0;
  const backfillActive = !!startedAt && (backfillRemaining ?? 0) > 0;
  const backfillStalled = backfillActive && !hasRecentActivity && !startingUp;
  const done = backfillDone ?? 0;
  const remaining = backfillRemaining ?? 0;

  if (backfillActive) {
    jobs.push({
      id: "backfill",
      type: "backfill",
      label: startingUp && !hasRecentActivity
        ? "Backfilling metadata — starting up…"
        : "Backfilling metadata",
      status: backfillStalled ? "stalled" : "running",
      scraped: done,
      total: done + remaining,
      startedAt,
      stalled: backfillStalled,
    });
  }

  return jobs;
}

export async function cancelCrawl(job_id: string) {
  await requireUser();
  const sb = createAdminClient();
  const { data: job } = await sb.from("crawl_jobs").select("status").eq("id", job_id).single();
  if (!job) return { error: "job_not_found" };
  if (job.status !== "running" && job.status !== "queued") {
    return { error: `cannot cancel job in status: ${job.status}` };
  }
  const { error } = await sb
    .from("crawl_jobs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", job_id);
  if (error) return { error: error.message };
  revalidatePath("/seeds");
  revalidatePath(`/seeds/jobs/${job_id}`);
  return { ok: true };
}

export async function retryCrawl(job_id: string, overridePassword?: string) {
  await requireUser();
  const admin = createAdminClient();
  const { data: prev } = await admin
    .from("crawl_jobs")
    .select("seed_id, status, max_depth")
    .eq("id", job_id)
    .single();
  if (!prev) return { error: "job_not_found" };
  if (prev.status !== "failed" && prev.status !== "cancelled") {
    return { error: `cannot retry job in status: ${prev.status}` };
  }

  const { data: seed } = await admin
    .from("seeds")
    .select("id, username, max_profiles_to_scrape, scrape_full_following")
    .eq("id", prev.seed_id)
    .single();
  if (!seed) return { error: "seed_not_found" };

  // This job failed, but the seed may have completed a crawl on another run —
  // retrying would then be a second scrape of an account already done.
  if (await hasBeenScraped(seed.id)) {
    const denied = checkRescrapeOverride(overridePassword);
    if (denied) return { error: denied };
  }

  const { data: job, error: jobErr } = await admin
    .from("crawl_jobs")
    .insert({ seed_id: seed.id, status: "queued", max_depth: prev.max_depth })
    .select("id")
    .single();
  if (jobErr || !job) return { error: jobErr?.message ?? "job_create_failed" };

  const { ids } = await inngest.send({
    name: "crawl/seed.requested",
    data: {
      crawl_job_id: job.id,
      seed_id: seed.id,
      seed_username: seed.username,
      profile_limit: seed.max_profiles_to_scrape ?? null,
      full_account: seed.scrape_full_following ?? false,
    },
  });
  await admin.from("crawl_jobs").update({ inngest_run_id: ids[0] ?? null }).eq("id", job.id);
  revalidatePath("/seeds");
  return { ok: true, crawl_job_id: job.id };
}
