import "server-only";
import { scrapingBeeGet, ScrapingBeeError } from "@/lib/scrapingbee/client";
import { extractEmailFromHtml, extractEmailFromText } from "@/lib/leads/email-extract";

export type YouTubeEmailResult = {
  email: string | null;
  error: string | null;
};

/**
 * Pull a *plaintext* business email off a YouTube channel's About page.
 *
 * We fetch `${channelUrl}/about` through ScrapingBee (mirroring lib/funnel/fetch.ts)
 * and scan the rendered HTML + the embedded `ytInitialData` description for any
 * address the creator published openly. We deliberately do NOT touch the gated
 * "View email address" button — that sits behind a reCAPTCHA/login wall and
 * extracting it would mean circumventing an access control. So this only ever
 * surfaces emails the creator already made public in their description/links.
 */
export async function findYouTubeChannelEmail(opts: {
  apiKey: string;
  channelUrl: string;
}): Promise<YouTubeEmailResult> {
  const aboutUrl = `${opts.channelUrl.replace(/\/$/, "")}/about`;

  let html = "";
  try {
    const r = await scrapingBeeGet({
      apiKey: opts.apiKey,
      url: aboutUrl,
      renderJs: true,
      premiumProxy: true,
      retries: 1,
    });
    html = r.body;
  } catch (err) {
    const msg = err instanceof ScrapingBeeError ? err.message : (err as Error).message;
    return { email: null, error: `about_fetch_failed: ${msg.slice(0, 200)}` };
  }

  // 1. mailto: links + visible text.
  const fromHtml = extractEmailFromHtml(html);
  if (fromHtml) return { email: fromHtml, error: null };

  // 2. The About description often lives only inside the embedded ytInitialData
  //    JSON blob, not the rendered DOM. Scan the raw response as a last resort;
  //    isPlausible() filters out YouTube/Google infra addresses.
  const fromRaw = extractEmailFromText(html);
  if (fromRaw) return { email: fromRaw, error: null };

  return { email: null, error: "no_email_on_about" };
}
