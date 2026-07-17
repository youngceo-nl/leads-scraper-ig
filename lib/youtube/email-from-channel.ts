import "server-only";
import { fetchYouTubeAboutWithCookie } from "@/lib/youtube/about-cookie";

// Runs the two cookie-backed YouTube email steps (free About-page scrape, then
// the CapSolver-gated reveal) against a single channel and reports whether the
// cookie itself was rejected — so the caller can refresh it and retry.
//
// Pulled out of the enrich pipeline so the "cookie went stale → re-mint → try
// again" loop lives in one place.

export type YtAttempt = {
  email: string | null;
  provider: "youtube_about" | "youtube_about_gated" | null;
  trace: string[]; // human-readable step log, appended to the pipeline trace
  youtubeError: string | null;
  authFailed: boolean; // the cookie is logged-out / expired
  updatedCookie: string | null; // refreshed cookie jar from Google's Set-Cookie headers
};

// HTTP statuses from the About-page fetch that indicate a dead session rather
// than "this channel simply has no email".
const AUTH_HTTP = /^http_(401|403)$/;

export async function attemptYoutubeEmail(opts: {
  channelUrl: string;
  googleCookie: string;
  capsolverKey: string;
  proxy?: string | null;
  profilePath?: string | null; // persistent Chrome profile to avoid DBSC failures
}): Promise<YtAttempt> {
  const { channelUrl, googleCookie, capsolverKey, proxy = null, profilePath = null } = opts;
  const trace: string[] = [];

  if (!googleCookie && !profilePath) {
    return { email: null, provider: null, trace: ["yt_cookie_scrape: skipped (no YT cookie or profile)"], youtubeError: null, authFailed: false, updatedCookie: null };
  }

  let youtubeError: string | null = null;
  let authFailed = false;
  let updatedCookie: string | null = null;

  // ── Free path: read an email the creator already published on About. ──
  const cookieScrape = await fetchYouTubeAboutWithCookie({ channelUrl, googleCookie });
  updatedCookie = cookieScrape.updatedCookie;
  if (cookieScrape.email) {
    trace.push("yt_cookie_scrape: found");
    return { email: cookieScrape.email, provider: "youtube_about", trace, youtubeError: null, authFailed: false, updatedCookie };
  }
  trace.push(`yt_cookie_scrape: ${cookieScrape.error ?? "none"}`);
  youtubeError = cookieScrape.error;
  if (cookieScrape.error && AUTH_HTTP.test(cookieScrape.error)) authFailed = true;

  // ── Gated path: solve the reCAPTCHA behind "View email address". ──
  if (capsolverKey) {
    try {
      const { revealYoutubeEmail } = await import("@/lib/youtube/reveal-email");
      const revealed = await revealYoutubeEmail({ channelUrl, googleCookie, capsolverKey, proxy, profilePath });
      if (revealed.email) {
        trace.push("yt_capsolver: found");
        return { email: revealed.email, provider: "youtube_about_gated", trace, youtubeError: null, authFailed: false, updatedCookie };
      }
      trace.push(`yt_capsolver: ${revealed.error ?? "none"}`);
      youtubeError = youtubeError ?? revealed.error;
      // reveal-email signals a logged-out cookie with "not signed in".
      if (revealed.error && /not signed in/i.test(revealed.error)) authFailed = true;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 100);
      trace.push(`yt_capsolver: failed (${msg})`);
      youtubeError = youtubeError ?? `reveal_failed: ${msg}`;
    }
  } else {
    trace.push("yt_capsolver: skipped (no CapSolver key)");
  }

  return { email: null, provider: null, trace, youtubeError, authFailed, updatedCookie };
}
