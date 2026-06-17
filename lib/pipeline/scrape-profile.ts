import "server-only";
import { scrapeProfiles, scrapePosts } from "@/lib/apify/actors";
import { scrapeProfileWithPostsViaScrapingBee } from "@/lib/scrapingbee/instagram";
import { fetchProfileMetadataDirect, InstagramDirectError } from "@/lib/instagram/direct";
import { buildCookiePool, pickCookie, markRateLimited } from "@/lib/instagram/cookie-pool";
import { logError } from "@/lib/pipeline/persist";
import { ensureProfileFields } from "@/lib/pipeline/normalize";
import type { AppSettings, ScrapedProfile } from "@/lib/types";

export async function scrapeProfileWithFallback(opts: {
  username: string;
  settings: AppSettings;
  apifyToken: string | null;
  crawl_job_id?: string | null;
}): Promise<{ profile: ScrapedProfile; provider: "apify" | "scrapingbee" | "direct" }> {
  const { username, settings } = opts;
  const sbKey = settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY || "";
  const sbCookie = settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE || null;
  const provider = settings.following_scraper_provider;

  const tryApify = async (): Promise<ScrapedProfile> => {
    if (!opts.apifyToken) throw new Error("Apify token not configured");
    const [profiles, postsByUser] = await Promise.all([
      scrapeProfiles({ token: opts.apifyToken, usernames: [username] }),
      scrapePosts({ token: opts.apifyToken, usernames: [username], limit: 12 }),
    ]);
    const p = profiles[0];
    if (!p) throw new Error(`profile not returned for ${username}`);
    return ensureProfileFields({ ...p, recent_posts: postsByUser.get(username) ?? [] });
  };

  const trySb = async (): Promise<ScrapedProfile> => {
    if (!sbKey) throw new Error("ScrapingBee API key not configured");
    const profile = await scrapeProfileWithPostsViaScrapingBee({ apiKey: sbKey, username, sessionCookie: sbCookie });
    if (!profile) throw new Error(`profile not returned for ${username} (SB)`);
    return ensureProfileFields(profile);
  };

  // Free direct fetch using cookie pool — no proxy needed.
  // Rotates through available cookies, marks any that get rate-limited.
  const tryDirect = async (): Promise<ScrapedProfile> => {
    const pool = buildCookiePool(settings);
    const cookie = pickCookie(pool);
    if (!cookie) throw new Error("No available Instagram session cookie in pool");
    try {
      const proxyUrl = settings.instagram_proxy_url || process.env.INSTAGRAM_PROXY_URL || null;
      const meta = await fetchProfileMetadataDirect({ username, sessionCookie: cookie, delayMs: Math.floor(Math.random() * 2000) + 500, proxyUrl });
      if (!meta) throw new Error(`Profile not found for ${username}`);
      return ensureProfileFields({
        username: meta.username,
        full_name: meta.full_name,
        profile_url: `https://www.instagram.com/${meta.username}/`,
        bio: meta.bio,
        external_link: meta.external_link,
        followers: meta.followers,
        following: meta.following,
        posts: meta.posts,
        is_private: meta.is_private,
        is_verified: meta.is_verified,
        recent_posts: meta.recent_posts,
      });
    } catch (err) {
      if (err instanceof InstagramDirectError && err.status === 429) {
        markRateLimited(cookie);
      }
      throw err;
    }
  };

  if (provider === "scrapingbee") return { profile: await trySb(), provider: "scrapingbee" };
  if (provider === "apify") return { profile: await tryApify(), provider: "apify" };

  // "cookie" or "auto": try free direct fetch first (cookie pool), then fall
  // back to Apify, then ScrapingBee — cheapest path first.
  const cookiePool = buildCookiePool(settings);
  if (provider === "cookie" || (provider === "auto" && cookiePool.length > 0)) {
    try {
      return { profile: await tryDirect(), provider: "direct" };
    } catch (directErr) {
      const msg = directErr instanceof Error ? directErr.message : String(directErr);
      await logError({
        context: "direct.profile.fallback",
        error_message: `Direct fetch failed, falling back: ${msg}`,
        payload: { username },
        crawl_job_id: opts.crawl_job_id ?? null,
      });
      // fall through to Apify/SB below
    }
  }

  try {
    return { profile: await tryApify(), provider: "apify" };
  } catch (apifyErr) {
    if (!sbKey) throw apifyErr;
    const msg = apifyErr instanceof Error ? apifyErr.message : String(apifyErr);
    await logError({
      context: "apify.profile.fallback",
      error_message: `Apify failed, trying ScrapingBee: ${msg}`,
      payload: { username },
      crawl_job_id: opts.crawl_job_id ?? null,
    });
    return { profile: await trySb(), provider: "scrapingbee" };
  }
}
