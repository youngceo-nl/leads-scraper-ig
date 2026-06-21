import "server-only";
import type { DiscoveredFollowing } from "@/lib/apify/actors";
import { fetchFollowingDirect, InstagramDirectError } from "@/lib/instagram/direct";
import { buildCookiePool, markRateLimited, isRateLimited } from "@/lib/instagram/cookie-pool";
import { logError } from "@/lib/pipeline/persist";
import type { AppSettings } from "@/lib/types";

export async function scrapeFollowingDetailedWithFallback(opts: {
  username: string;
  settings: AppSettings;
  apifyToken: string | null;
  crawl_job_id?: string | null;
  limitOverride?: number | null;
  startCursor?: string | null;
}): Promise<{ items: DiscoveredFollowing[]; provider: "playwright" | "cookie"; nextCursor: string | null }> {
  const { username, settings } = opts;
  const cookiePool = buildCookiePool(settings);
  const limit = opts.limitOverride && opts.limitOverride > 0
    ? opts.limitOverride
    : settings.max_profiles_per_account;

  // 1. Playwright — real Chromium, best success rate, no hard cap
  const tryPlaywright = async () => {
    const available = cookiePool.filter(e => !isRateLimited(e.cookie));
    if (available.length === 0) throw new Error("No Instagram cookies available for Playwright");
    const entry = available[0];
    const { scrapeFollowingPlaywright } = await import("@/lib/instagram/playwright-scraper");
    const proxyUrl = entry.proxyUrl ?? settings.instagram_proxy_url ?? process.env.INSTAGRAM_PROXY_URL ?? null;
    const items = await scrapeFollowingPlaywright({ username, cookie: entry.cookie, limit, proxyUrl });
    return { items, provider: "playwright" as const, nextCursor: null };
  };

  // 2. Direct cookie — rotates through pool, tracks rate limits
  const tryCookie = async () => {
    if (cookiePool.length === 0) throw new Error("No Instagram session cookies configured");
    const available = cookiePool.filter(e => !isRateLimited(e.cookie));
    if (available.length === 0) {
      throw new Error(`All ${cookiePool.length} Instagram cookie(s) are rate-limited — wait ~2h or add more accounts`);
    }
    let lastErr: Error | null = null;
    for (const entry of available) {
      try {
        const r = await fetchFollowingDirect({ username, sessionCookie: entry.cookie, limit, startCursor: opts.startCursor });
        return { items: r.items, provider: "cookie" as const, nextCursor: r.nextCursor };
      } catch (err) {
        if (err instanceof InstagramDirectError) {
          if (err.status === 429) markRateLimited(entry.cookie);
          // Try next cookie regardless — 401 = expired, 403 = flagged, etc.
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("All Instagram cookies exhausted");
  };

  // Try Playwright first (hard 5-min cap), fall back to direct cookie.
  // If Playwright returns 0 items (silent fail — dialog didn't open, UI changed, etc.)
  // treat it the same as an error and try the cookie path.
  const PLAYWRIGHT_TIMEOUT_MS = 5 * 60 * 1000;
  try {
    const r = await Promise.race([
      tryPlaywright(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Playwright timed out after 5 minutes")), PLAYWRIGHT_TIMEOUT_MS)
      ),
    ]);
    if (r.items.length > 0) return r;
    await logError({
      context: "playwright.following.fallback",
      error_message: "Playwright returned 0 items, falling back to cookie",
      payload: { username },
      crawl_job_id: opts.crawl_job_id ?? null,
    });
  } catch (err) {
    await logError({
      context: "playwright.following.fallback",
      error_message: `Playwright failed, falling back to cookie: ${err instanceof Error ? err.message : String(err)}`,
      payload: { username },
      crawl_job_id: opts.crawl_job_id ?? null,
    });
  }

  return await tryCookie();
}
