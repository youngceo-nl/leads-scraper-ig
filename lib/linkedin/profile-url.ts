// Pure helper (no I/O) — detect & normalize a LinkedIn *personal profile* URL
// (/in/<handle>) from any arbitrary link, e.g. an Instagram bio's external_link.
// Returns the canonical profile URL or null (company pages, posts, non-LinkedIn).

const PROFILE_RE = /^\/in\/([A-Za-z0-9%_-]+)\/?$/i;

export function extractLinkedInProfileUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let input = raw.trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;

  const m = u.pathname.match(PROFILE_RE);
  if (!m) return null;

  return `https://www.linkedin.com/in/${m[1]}`;
}
