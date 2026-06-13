import "server-only";
import { scrapeFollowing as apifyFollowing, scrapeFollowingDetailed as apifyFollowingDetailed, type DiscoveredFollowing } from "@/lib/apify/actors";
import { scrapeFollowingViaScrapingBee } from "@/lib/scrapingbee/instagram";
import { fetchFollowingDirect } from "@/lib/instagram/direct";
import { logError } from "@/lib/pipeline/persist";
import type { AppSettings } from "@/lib/types";

// Provider-aware following scrape.
// - "apify"      → Apify only
// - "scrapingbee"→ ScrapingBee only (requires IG session cookie)
// - "auto"      → Apify first, fall back to ScrapingBee if Apify fails AND SB key is configured
//
// Returns the username list AND the provider that ultimately succeeded.
export async function scrapeFollowingWithFallback(opts: {
  username: string;
  settings: AppSettings;
  apifyToken: string | null;
  crawl_job_id?: string | null;
  // Per-call override for max followings to fetch. Falls back to settings.max_profiles_per_account.
  limitOverride?: number | null;
}): Promise<{ usernames: string[]; provider: "apify" | "scrapingbee" }> {
  const { username, settings, apifyToken } = opts;
  const sbKey = settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY || "";
  const sbCookie = settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE || null;
  const provider = settings.following_scraper_provider;
  const limit = opts.limitOverride && opts.limitOverride > 0
    ? opts.limitOverride
    : settings.max_profiles_per_account;

  const tryApify = async () => {
    if (!apifyToken) throw new Error("Apify token not configured");
    return apifyFollowing({
      token: apifyToken,
      username,
      limit,
    });
  };

  const trySb = async () => {
    if (!sbKey) throw new Error("ScrapingBee API key not configured");
    return scrapeFollowingViaScrapingBee({
      apiKey: sbKey,
      username,
      limit,
      sessionCookie: sbCookie,
    });
  };

  if (provider === "scrapingbee") {
    return { usernames: await trySb(), provider: "scrapingbee" };
  }
  if (provider === "apify") {
    return { usernames: await tryApify(), provider: "apify" };
  }

  // auto: apify first, sb fallback if configured
  try {
    const usernames = await tryApify();
    return { usernames, provider: "apify" };
  } catch (apifyErr) {
    const apifyMsg = apifyErr instanceof Error ? apifyErr.message : String(apifyErr);
    if (!sbKey) throw apifyErr;
    await logError({
      context: "apify.following.fallback",
      error_message: `Apify failed, trying ScrapingBee: ${apifyMsg}`,
      payload: { username },
      crawl_job_id: opts.crawl_job_id ?? null,
    });
    const usernames = await trySb();
    return { usernames, provider: "scrapingbee" };
  }
}

// Detailed variant: returns the per-follower metadata so we can bulk-upsert
// leads with full_name / is_private / etc. instead of just usernames.
// Provider priority:
//   1. COOKIE  → free direct fetch with the burner session cookie (always
//                preferred when cookie is set, regardless of provider setting)
//   2. APIFY   → community actor, paid
//   3. SB      → ScrapingBee residential proxies, paid
export async function scrapeFollowingDetailedWithFallback(opts: {
  username: string;
  settings: AppSettings;
  apifyToken: string | null;
  crawl_job_id?: string | null;
  limitOverride?: number | null;
}): Promise<{ items: DiscoveredFollowing[]; provider: "cookie" | "apify" | "scrapingbee" }> {
  const { username, settings, apifyToken } = opts;
  const sbKey = settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY || "";
  const sbCookie = (settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE || "").trim();
  const provider = settings.following_scraper_provider;
  const limit = opts.limitOverride && opts.limitOverride > 0
    ? opts.limitOverride
    : settings.max_profiles_per_account;

  const tryCookie = async (): Promise<DiscoveredFollowing[]> => {
    if (!sbCookie) throw new Error("IG session cookie not configured");
    return fetchFollowingDirect({ username, sessionCookie: sbCookie, limit });
  };

  const tryApify = async (): Promise<DiscoveredFollowing[]> => {
    if (!apifyToken) throw new Error("Apify token not configured");
    const items = await apifyFollowingDetailed({ token: apifyToken, username, limit });
    // Apify actor minimum is 100 — trim to the requested limit so the seed's
    // max_profiles_to_scrape is honored.
    return items.slice(0, limit);
  };

  const trySb = async (): Promise<DiscoveredFollowing[]> => {
    if (!sbKey) throw new Error("ScrapingBee API key not configured");
    const usernames = await scrapeFollowingViaScrapingBee({
      apiKey: sbKey,
      username,
      limit,
      sessionCookie: sbCookie || null,
    });
    return usernames.slice(0, limit).map((u) => ({
      username: u.toLowerCase(),
      full_name: null,
      is_private: false,
      is_verified: false,
      profile_pic_url: null,
      ig_user_id: null,
    }));
  };

  // 1. Free cookie path wins whenever cookie is available.
  if (sbCookie) {
    try {
      return { items: await tryCookie(), provider: "cookie" };
    } catch (cookieErr) {
      const msg = cookieErr instanceof Error ? cookieErr.message : String(cookieErr);
      await logError({
        context: "ig.cookie.following.fallback",
        error_message: `Cookie path failed, falling back to provider=${provider}: ${msg}`,
        payload: { username },
        crawl_job_id: opts.crawl_job_id ?? null,
      });
      // fall through to the configured paid provider
    }
  }

  if (provider === "scrapingbee") {
    return { items: await trySb(), provider: "scrapingbee" };
  }
  if (provider === "apify") {
    return { items: await tryApify(), provider: "apify" };
  }
  try {
    return { items: await tryApify(), provider: "apify" };
  } catch (apifyErr) {
    const apifyMsg = apifyErr instanceof Error ? apifyErr.message : String(apifyErr);
    if (!sbKey) throw apifyErr;
    await logError({
      context: "apify.following.fallback",
      error_message: `Apify failed, trying ScrapingBee: ${apifyMsg}`,
      payload: { username },
      crawl_job_id: opts.crawl_job_id ?? null,
    });
    return { items: await trySb(), provider: "scrapingbee" };
  }
}
