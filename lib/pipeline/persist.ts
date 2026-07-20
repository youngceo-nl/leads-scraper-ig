import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ClaudeScore, Lead, ScrapedProfile } from "@/lib/types";
import type { ComputedMetrics } from "./metrics";
import type { DiscoveredFollowing } from "@/lib/apify/actors";
import { getExcludedUsernames } from "./exclusions";

type Args = {
  profile: ScrapedProfile;
  metrics: ComputedMetrics | null;
  score: ClaudeScore | null;
  status: Lead["status"];
  rejection_reason: string | null;
  crawl_depth: number;
  source_seed_id: string | null;
  parent_username: string | null;
  lead_source?: string | null;
};

export async function persistLead(args: Args) {
  const sb = createAdminClient();
  const row = {
    username: args.profile.username,
    full_name: args.profile.full_name,
    profile_url: args.profile.profile_url,
    bio: args.profile.bio,
    external_link: args.profile.external_link,
    is_private: args.profile.is_private,
    is_verified: args.profile.is_verified,
    followers: args.profile.followers,
    following: args.profile.following,
    posts: args.profile.posts,

    avg_likes: args.metrics?.avg_likes ?? null,
    avg_comments: args.metrics?.avg_comments ?? null,
    avg_views: args.metrics?.avg_views ?? null,
    engagement_rate: args.metrics?.engagement_rate ?? null,
    posts_last_30_days: args.metrics?.posts_last_30_days ?? null,
    reels_last_30_days: args.metrics?.reels_last_30_days ?? null,
    activity_status: args.metrics?.activity_status ?? null,

    recent_posts: args.profile.recent_posts,

    niche: args.score?.niche ?? null,
    business_model: args.score?.business_model ?? null,
    offer_type: args.score?.offer_type ?? null,
    audience_type: args.score?.audience_type ?? null,
    icp_fit_score: args.score?.icp_fit_score ?? null,
    traction_score: args.score?.traction_score ?? null,
    monetization_score: args.score?.monetization_score ?? null,
    activity_score: args.score?.activity_score ?? null,
    overall_score: args.score?.overall_score ?? null,
    reason_for_score: args.score?.reason_for_score ?? null,
    recommended_action: args.score?.recommended_action ?? null,

    status: args.status,
    rejection_reason: args.rejection_reason,
    crawl_depth: args.crawl_depth,
    source_seed_id: args.source_seed_id,
    parent_username: args.parent_username,
    lead_source: args.lead_source ?? null,
  };

  const { data, error } = await sb
    .from("leads")
    .upsert(row, { onConflict: "username" })
    .select("id, username")
    .single();
  if (error) throw new Error(`persistLead failed for ${row.username}: ${error.message}`);
  return data;
}

// Bulk-insert newly discovered usernames as `pending` leads with the minimal
// metadata we have from the following-scraper. Skips usernames already in DB.
// Returns the count actually inserted.
export type UpsertResult = {
  /** Genuinely new leads written to the table. */
  inserted: number;
  /** Usernames that already existed — the upsert's ignoreDuplicates skipped them. */
  duplicates: number;
  /** Usernames dropped because they were previously bulk-deleted. */
  excluded: number;
};

export async function bulkUpsertDiscoveredLeads(
  items: DiscoveredFollowing[],
  opts: {
    crawl_depth: number;
    source_seed_id: string | null;
    parent_username: string | null;
  },
): Promise<UpsertResult> {
  if (items.length === 0) return { inserted: 0, duplicates: 0, excluded: 0 };
  const sb = createAdminClient();

  // Drop any usernames the user previously bulk-deleted — never re-add them.
  const excludedSet = await getExcludedUsernames(items.map((i) => i.username));
  const fresh = excludedSet.size
    ? items.filter((i) => !excludedSet.has(i.username.toLowerCase()))
    : items;
  const excluded = items.length - fresh.length;
  if (fresh.length === 0) return { inserted: 0, duplicates: 0, excluded };

  const rows = fresh.map((i) => ({
    username: i.username,
    full_name: i.full_name,
    profile_url: `https://www.instagram.com/${i.username}/`,
    is_private: i.is_private,
    is_verified: i.is_verified,
    status: "pending" as const,
    crawl_depth: opts.crawl_depth,
    source_seed_id: opts.source_seed_id,
    parent_username: opts.parent_username,
  }));

  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { data, error } = await sb
      .from("leads")
      .upsert(batch, { onConflict: "username", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`bulkUpsertDiscoveredLeads failed: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  // ignoreDuplicates skips a row silently on conflict rather than reporting it,
  // so "how many already existed" is the remainder, not something Postgres hands back.
  const duplicates = fresh.length - inserted;
  return { inserted, duplicates, excluded };
}

export async function logCrawl(opts: {
  crawl_job_id: string | null;
  profile_username: string;
  parent_username: string | null;
  action: string;
  depth: number;
  status?: "success" | "failure";
  detail?: string;
}) {
  const sb = createAdminClient();
  await sb.from("crawl_logs").insert({
    crawl_job_id: opts.crawl_job_id,
    profile_username: opts.profile_username,
    parent_username: opts.parent_username,
    action: opts.action,
    depth: opts.depth,
    status: opts.status ?? "success",
    detail: opts.detail ?? null,
  });
}

export async function logError(opts: {
  context: string;
  error_message: string;
  payload?: unknown;
  crawl_job_id?: string | null;
}) {
  const sb = createAdminClient();
  await sb.from("error_logs").insert({
    context: opts.context,
    error_message: opts.error_message.slice(0, 4000),
    payload: opts.payload ?? null,
    crawl_job_id: opts.crawl_job_id ?? null,
  });
}

export async function getJobStatus(crawl_job_id: string): Promise<string | null> {
  const sb = createAdminClient();
  const { data } = await sb.from("crawl_jobs").select("status").eq("id", crawl_job_id).single();
  return data?.status ?? null;
}

/**
 * Increments the live funnel counters shown on the Activity page.
 *
 * Goes through the bump_crawl_counters SQL function rather than a
 * read-modify-write: score-lead fans out and runs several leads concurrently,
 * so reading then writing from here would lose counts. Never throws — a
 * miscounted funnel must not fail the pipeline stage that reported it.
 */
export async function bumpFunnelCounters(opts: {
  crawl_job_id: string | null;
  found?: number;
  backfilled?: number;
  filtered?: number;
  verified?: number;
  duplicate?: number;
  excluded?: number;
}) {
  if (!opts.crawl_job_id) return; // work outside a run counts toward no run
  const sb = createAdminClient();
  const { error } = await sb.rpc("bump_crawl_counters", {
    p_job_id: opts.crawl_job_id,
    p_found: opts.found ?? 0,
    p_backfilled: opts.backfilled ?? 0,
    p_filtered: opts.filtered ?? 0,
    p_verified: opts.verified ?? 0,
    p_duplicate: opts.duplicate ?? 0,
    p_excluded: opts.excluded ?? 0,
  });
  if (error) console.error("[bumpFunnelCounters]", error.message);
}

export async function bumpJobCounters(opts: {
  crawl_job_id: string;
  scraped?: number;
  qualified?: number;
  rejected?: number;
  depth?: number;
}) {
  const sb = createAdminClient();
  // Read-modify-write is fine here — concurrency is bounded by Inngest step locks.
  const { data: cur } = await sb
    .from("crawl_jobs")
    .select("profiles_scraped, qualified_count, rejected_count, current_depth")
    .eq("id", opts.crawl_job_id)
    .single();
  if (!cur) return;
  const patch = {
    profiles_scraped: cur.profiles_scraped + (opts.scraped ?? 0),
    qualified_count: cur.qualified_count + (opts.qualified ?? 0),
    rejected_count: cur.rejected_count + (opts.rejected ?? 0),
    current_depth: opts.depth != null ? Math.max(cur.current_depth, opts.depth) : cur.current_depth,
  };
  await sb.from("crawl_jobs").update(patch).eq("id", opts.crawl_job_id);
}
