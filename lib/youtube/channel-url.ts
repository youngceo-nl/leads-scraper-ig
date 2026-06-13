// Pure helper (no I/O) — detect & normalize a YouTube *channel* URL from any
// arbitrary link, e.g. an Instagram bio's external_link. Returns the canonical
// channel URL when the link points at a channel, or null otherwise (videos,
// shorts, playlists, search pages, or non-YouTube hosts).

const CHANNEL_PATH_RE =
  /^\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)$/i;

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
]);

export function extractYouTubeChannelUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let input = raw.trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }

  if (!YT_HOSTS.has(u.hostname.toLowerCase())) return null;

  // Only the first path segment matters for channel detection. Strip a trailing
  // "/about", "/videos", "/featured" etc. before matching the channel shape.
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0];
  const channelPath =
    first.startsWith("@")
      ? `/${first}`
      : ["channel", "c", "user"].includes(first.toLowerCase()) && segments[1]
        ? `/${first}/${segments[1]}`
        : null;

  if (!channelPath || !CHANNEL_PATH_RE.test(channelPath)) return null;

  // Canonical form: always www host, no query/hash, no trailing slash.
  return `https://www.youtube.com${channelPath}`;
}
