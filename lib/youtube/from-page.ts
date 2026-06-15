import "server-only";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";

// Follow a link-in-bio page (Linktree, Beacons, Stan, Komi, a personal site …)
// and pull the creator's YouTube channel out of it. This is far more precise than
// guessing the channel from their name via search — the "YouTube" button on their
// own landing page points straight at the real channel.
//
// Free, no API. Plain HTML fetch: Linktree/Beacons/etc. embed outbound links in
// the server-rendered HTML (anchor hrefs + a __NEXT_DATA__/JSON blob), so a regex
// over the raw markup finds the channel without needing to execute their JS.

const UA = "Mozilla/5.0 (compatible; LeadBot/1.0)";

// Channel-shaped YouTube URLs (handle / channel-id / legacy c|user).
const CHANNEL_IN_HTML =
  /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)/gi;

// Video/short/live links — used only as a fallback to resolve the owning channel
// when no direct channel link is present on the page.
const VIDEO_IN_HTML =
  /https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/|live\/)[A-Za-z0-9_-]+|youtu\.be\/[A-Za-z0-9_-]+)/gi;

export async function findYouTubeChannelFromPage(
  url: string,
): Promise<{ url: string | null; error: string | null }> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { url: null, error: `http_${res.status}` };
    html = await res.text();
  } catch (err) {
    return { url: null, error: `fetch_failed: ${(err as Error).message.slice(0, 150)}` };
  }

  // Unescape JSON-encoded ("\/") and HTML-entity ("&amp;") URLs so the regexes
  // match links buried in __NEXT_DATA__ as readily as plain anchor hrefs.
  const decoded = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");

  // 1) A direct channel link — the common case (the "YouTube" button).
  for (const m of decoded.match(CHANNEL_IN_HTML) ?? []) {
    const canon = extractYouTubeChannelUrl(m);
    if (canon) return { url: canon, error: null };
  }

  // 2) Only a video/short link on the page → resolve it to its owning channel.
  const firstVideo = decoded.match(VIDEO_IN_HTML)?.[0];
  if (firstVideo) {
    const channel = await channelFromVideo(firstVideo);
    if (channel) return { url: channel, error: null };
  }

  return { url: null, error: "no_youtube_link_on_page" };
}

// Fetch a video/short page and read the owning channel id (or @handle) out of it.
async function channelFromVideo(videoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(videoUrl, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const id =
      html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ??
      html.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1];
    if (id) return `https://www.youtube.com/channel/${id}`;
    const handle = html.match(/"canonicalBaseUrl":"\/(@[A-Za-z0-9._-]+)"/)?.[1];
    if (handle) return `https://www.youtube.com/${handle}`;
    return null;
  } catch {
    return null;
  }
}
