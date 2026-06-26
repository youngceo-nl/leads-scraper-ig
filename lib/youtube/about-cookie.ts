import "server-only";
import { extractEmailFromHtml, extractEmailFromText } from "@/lib/leads/email-extract";
import { mergeCookiesFromResponse } from "@/lib/youtube/cookie-jar";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Fetches a YouTube channel's About page using a logged-in Google cookie and
 * scans both the rendered HTML and the embedded ytInitialData JSON for any
 * email the creator published openly in their description or links.
 *
 * Does NOT touch the gated "View email address" button — use revealYoutubeEmail
 * for that. This step is free (no CAPTCHA solving needed for public emails).
 */
export async function fetchYouTubeAboutWithCookie(opts: {
  channelUrl: string;
  googleCookie: string;
}): Promise<{ email: string | null; error: string | null; updatedCookie: string | null }> {
  const aboutUrl = opts.channelUrl.replace(/\/+$/, "").replace(/\/about$/i, "") + "/about";

  let html: string;
  let updatedCookie: string | null = null;
  try {
    const res = await fetch(aboutUrl, {
      headers: {
        Cookie: opts.googleCookie,
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Mode": "navigate",
      },
      signal: AbortSignal.timeout(12_000),
    });
    updatedCookie = mergeCookiesFromResponse(opts.googleCookie, res.headers);
    if (!res.ok) return { email: null, error: `http_${res.status}`, updatedCookie };
    html = await res.text();
  } catch (err) {
    return { email: null, error: `fetch_failed: ${(err as Error).message.slice(0, 200)}`, updatedCookie: null };
  }

  const fromHtml = extractEmailFromHtml(html);
  if (fromHtml) return { email: fromHtml, error: null, updatedCookie };

  // ytInitialData embeds the channel description as JSON — scan the raw text.
  const fromText = extractEmailFromText(html);
  if (fromText) return { email: fromText, error: null, updatedCookie };

  return { email: null, error: "no_email_on_about", updatedCookie };
}
