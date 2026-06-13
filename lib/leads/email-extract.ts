// Pure email extraction — no I/O, no server-only deps so it stays easy to test.
// Shared by the IG-bio step and the YouTube-About step of the enrichment waterfall.
import * as cheerio from "cheerio";

// Standard-ish email matcher. Intentionally conservative on the local part to
// avoid swallowing trailing punctuation from prose.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

// Domains / fragments that are never a real contact address — analytics, CDNs,
// the platform's own infra, schema boilerplate, or image sprites like "logo@2x.png".
const NOISE_DOMAINS = [
  "youtube.com", "ytimg.com", "google.com", "googleapis.com", "googleusercontent.com",
  "gstatic.com", "schema.org", "w3.org", "sentry.io", "sentry-next.wixpress.com",
  "example.com", "example.org", "domain.com", "email.com", "wixpress.com",
  "facebook.com", "sentry.wixpress.com",
];
const NOISE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];

function isPlausible(email: string): boolean {
  const lower = email.toLowerCase();
  if (NOISE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  const domain = lower.slice(lower.indexOf("@") + 1);
  if (NOISE_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return false;
  // Guard against version/sprite tokens like "icon@2x" that slipped past the ext check.
  if (/@\d+x$/.test(lower)) return false;
  return true;
}

// Turn "name (at) domain (dot) com" / "name [at] domain dot com" into a real address.
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[\(\[\{]\s*(?:at|AT)\s*[\)\]\}]\s*/g, "@")
    .replace(/\s+(?:at|AT)\s+/g, "@")
    .replace(/\s*[\(\[\{]\s*(?:dot|DOT)\s*[\)\]\}]\s*/g, ".")
    .replace(/\s+(?:dot|DOT)\s+/g, ".");
}

/** First plausible email found in free text, with light "(at)/(dot)" deobfuscation. */
export function extractEmailFromText(text: string | null | undefined): string | null {
  if (!text) return null;

  const direct = matchFirst(text);
  if (direct) return direct;

  // Deobfuscation ("name at domain dot com") is only safe on short human text —
  // on a full HTML doc the loose "at"/"dot" rewrite would manufacture false
  // positives. Restrict it to bio/description-sized strings.
  if (
    text.length <= 2000 &&
    /\b(?:at|AT)\b/.test(text) &&
    /\b(?:dot|DOT)\b/.test(text)
  ) {
    return matchFirst(deobfuscate(text));
  }
  return null;
}

function matchFirst(text: string): string | null {
  const matches = text.match(EMAIL_RE);
  if (!matches) return null;
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:]+$/, "");
    if (isPlausible(cleaned)) return cleaned.toLowerCase();
  }
  return null;
}

/**
 * Extract an email from an HTML document. Prefers explicit `mailto:` links
 * (highest confidence), then falls back to scanning the visible text. Used for
 * the YouTube channel About page, whose description/links carry any plaintext
 * address the creator chose to publish.
 */
export function extractEmailFromHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);

  // 1. mailto: hrefs
  let found: string | null = null;
  $('a[href^="mailto:"]').each((_, el) => {
    if (found) return;
    const href = $(el).attr("href") ?? "";
    const addr = decodeURIComponent(href.replace(/^mailto:/i, "").split("?")[0]).trim();
    const m = matchFirst(addr);
    if (m) found = m;
  });
  if (found) return found;

  // 2. Visible text fallback.
  return extractEmailFromText($("body").text() || $.text());
}
