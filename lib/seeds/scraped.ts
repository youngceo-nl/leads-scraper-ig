import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Seeds that have completed at least one crawl.
 *
 * Derived from crawl_jobs rather than stored on the seed: job history is
 * already the record of what ran, and a duplicate flag could drift from it.
 * Only 'completed' counts — a failed or cancelled run scraped nothing worth
 * protecting, so those seeds stay crawlable without an override.
 */
export async function getScrapedSeedIds(seedIds?: string[]): Promise<Set<string>> {
  const sb = createAdminClient();
  let query = sb.from("crawl_jobs").select("seed_id").eq("status", "completed");
  if (seedIds?.length) query = query.in("seed_id", seedIds);

  const { data } = await query;
  return new Set((data ?? []).map((job) => job.seed_id).filter(Boolean) as string[]);
}

export async function hasBeenScraped(seedId: string): Promise<boolean> {
  const sb = createAdminClient();
  const { count } = await sb
    .from("crawl_jobs")
    .select("id", { count: "exact", head: true })
    .eq("seed_id", seedId)
    .eq("status", "completed");
  return (count ?? 0) > 0;
}

/**
 * Gate for re-scraping an account that already has a completed crawl.
 *
 * The password is env-only and deliberately not in app_settings: there is one
 * shared login, so anything on the Settings page is visible to the same person
 * this is meant to slow down. It guards against an accidental re-scrape (which
 * costs credits and re-walks a list already processed), not against an
 * attacker.
 */
export function checkRescrapeOverride(password: string | undefined): string | null {
  const expected = process.env.RESCRAPE_OVERRIDE_PASSWORD;
  if (!expected) {
    return "This account has already been scraped. Re-scraping needs RESCRAPE_OVERRIDE_PASSWORD set in the environment.";
  }
  if (!password) return "This account has already been scraped. Enter the override password to scrape it again.";
  if (!timingSafeEqual(password, expected)) return "Wrong override password.";
  return null;
}

/** Constant-time compare so a wrong guess can't be narrowed by response timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
