import type { AppSettings, ScrapedProfile } from "@/lib/types";

export type FilterResult = { ok: true } | { ok: false; reason: string };

// Hard filter — runs BEFORE Claude. Cheap rejections to save API spend.
export function hardFilter(profile: ScrapedProfile, settings: AppSettings): FilterResult {
  if (profile.is_private) return { ok: false, reason: "private_account" };

  if (profile.followers < settings.min_followers) {
    return { ok: false, reason: `followers_below_min (${profile.followers} < ${settings.min_followers})` };
  }
  if (profile.followers > settings.max_followers) {
    return { ok: false, reason: `followers_above_max (${profile.followers} > ${settings.max_followers})` };
  }

  if (!profile.bio || profile.bio.trim().length < 5) {
    return { ok: false, reason: "no_bio" };
  }

  if (!profile.recent_posts || profile.recent_posts.length === 0) {
    return { ok: false, reason: "no_recent_posts" };
  }

  // Keyword filters.
  // Identity haystack (bio + name + username) is what defines WHO the account is —
  // used for excludes/junk so a stray caption mentioning "news"/"meme" can't trigger
  // a false rejection.
  const identityHaystack = `${profile.bio} ${profile.full_name ?? ""} ${profile.username}`.toLowerCase();
  if (settings.exclude_keywords?.length) {
    const hit = settings.exclude_keywords.find((kw) => kw && identityHaystack.includes(kw.toLowerCase()));
    if (hit) return { ok: false, reason: `excluded_keyword:${hit}` };
  }
  // Include match also scans recent captions + external link, where the offer/ICP
  // signals usually live. Many strong leads describe their offer in their content,
  // not their bio (e.g. an AI-agency course whose bio just says "selling AI to businesses"),
  // so restricting the match to the bio produces false negatives.
  if (settings.include_keywords?.length) {
    const captions = (profile.recent_posts ?? []).map((p) => p.caption ?? "").join(" ");
    const includeHaystack = `${identityHaystack} ${captions} ${profile.external_link ?? ""}`.toLowerCase();
    const hit = settings.include_keywords.some((kw) => kw && includeHaystack.includes(kw.toLowerCase()));
    if (!hit) return { ok: false, reason: "no_include_keyword_match" };
  }

  // Obvious junk heuristics
  const junkBio = /\b(meme|fan ?page|memes|news|gossip|paparazzi)\b/i;
  if (profile.bio && junkBio.test(profile.bio)) {
    return { ok: false, reason: "junk_keyword_in_bio" };
  }

  return { ok: true };
}

// A "0 reels in the last 30 days" verdict is only trustworthy when we actually
// captured some reels to judge. With no reel sample (e.g. a scraper path that
// doesn't fetch reels, or an expired cookie) the count is an artifact of an
// incomplete scrape, not proven inactivity — hard-rejecting on it discards
// strong leads. Below this many scraped reels we skip the recency reject and
// defer to scoring, where low activity simply yields a low activity_score.
const MIN_REEL_SAMPLE_FOR_RECENCY = 3;

// Post-metric gate — applied after metrics computed, still pre-Claude.
export function metricsGate(
  metrics: { engagement_rate: number | null; reels_last_30_days: number },
  settings: AppSettings,
  reelSampleSize: number,
): FilterResult {
  if ((metrics.engagement_rate ?? 0) < settings.min_engagement_rate) {
    return {
      ok: false,
      reason: `engagement_below_min (${metrics.engagement_rate ?? 0} < ${settings.min_engagement_rate})`,
    };
  }
  if (
    reelSampleSize >= MIN_REEL_SAMPLE_FOR_RECENCY &&
    metrics.reels_last_30_days < settings.min_reels_last_30_days
  ) {
    return {
      ok: false,
      reason: `reels_30d_below_min (${metrics.reels_last_30_days} < ${settings.min_reels_last_30_days})`,
    };
  }
  return { ok: true };
}
