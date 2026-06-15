import "server-only";
import { serperSearch, SerperError, type SerperOrganic } from "@/lib/serper/client";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type YouTubeLookupResult = {
  url: string | null;
  candidates: string[];
  error: string | null;
};

/**
 * Find a person's / brand's YouTube channel via Serper.dev (Google Search API).
 *
 * Searches by full name when we have one (≥2 tokens); otherwise falls back to the
 * Instagram username — creators very often reuse their handle across platforms,
 * so a single-name lead is no longer a dead end. We read the structured `organic`
 * results, keep channel URLs, and return the first whose handle overlaps the name
 * tokens or the username.
 */
export async function findYouTubeChannel(opts: {
  apiKey: string;
  fullName?: string | null;
  username?: string | null;
  hints?: string | null;
}): Promise<YouTubeLookupResult> {
  // IG display names are often decorated with a tagline ("Trey Howe | 1% Better
  // Everyday"). Quoting that whole string makes the exact-match Google query
  // return nothing, so search on the clean name only.
  const cleanName = cleanDisplayName(opts.fullName);
  const tokens = nameTokens(cleanName);
  const username = cleanUsername(opts.username);

  if (tokens.length < 2 && !username) {
    return { url: null, candidates: [], error: "skipped:no_name_or_username" };
  }

  // Build the search attempts in priority order. The full name is most precise,
  // but creators very often brand their channel by handle, so a channel won't
  // surface under the legal name (e.g. "Matthew Ganzak" → channel @mattganzak).
  // Falling back to the IG handle catches those.
  const attempts: string[] = [];
  if (tokens.length >= 2) {
    const hint = (opts.hints ?? "").trim().slice(0, 80);
    attempts.push(`"${cleanName}"${hint ? " " + hint : ""} site:youtube.com`);
  }
  if (username) attempts.push(`"${username}" site:youtube.com`);

  const allCandidates: string[] = [];
  for (const query of attempts) {
    const r = await runSearch(opts.apiKey, query);
    // Hard search failure (network/quota): only abort if we have nothing else.
    if (r.error) {
      if (allCandidates.length === 0 && query === attempts[attempts.length - 1]) {
        return { url: null, candidates: allCandidates, error: r.error };
      }
      continue;
    }
    mergeCandidates(allCandidates, r.candidates);

    // Cheap slug match first, then resolve opaque /channel/UC… by fetching it.
    const matched =
      pickBestCandidate(r.candidates, tokens, username) ??
      (await verifyOpaqueCandidates(r.candidates, tokens, username));
    if (matched) return { url: matched, candidates: allCandidates, error: null };
  }

  if (allCandidates.length === 0) return { url: null, candidates: [], error: "no_serp_match" };
  // Found channels but none verified as this person — surface them for debugging.
  const sample = allCandidates.slice(0, 3).join(", ");
  return { url: null, candidates: allCandidates, error: `no_name_overlap [${allCandidates.length}: ${sample}]` };
}

// One Serper search reduced to channel-URL candidates. Returns an error string
// (never throws) so the caller can decide whether to fall through to the next
// attempt or give up.
async function runSearch(apiKey: string, query: string): Promise<{ candidates: string[]; error: string | null }> {
  try {
    const r = await serperSearch({ apiKey, query, num: 10, retries: 1 });
    return { candidates: channelCandidates(r.organic), error: null };
  } catch (err) {
    const msg = err instanceof SerperError ? err.message : (err as Error).message;
    return { candidates: [], error: `serp_failed: ${msg.slice(0, 200)}` };
  }
}

function mergeCandidates(into: string[], more: string[]): void {
  for (const u of more) if (!into.includes(u)) into.push(u);
}

// Resolves opaque /channel/UC… candidates by fetching each channel page and
// checking its title (and @handle) against the name tokens / username. Capped
// at 3 fetches so a noisy result set can't blow up the cost.
async function verifyOpaqueCandidates(candidates: string[], tokens: string[], username: string | null): Promise<string | null> {
  const opaque = candidates.filter((u) => extractSlug(u) === null).slice(0, 3);
  for (const url of opaque) {
    const info = await fetchChannelIdentity(url);
    if (!info) continue;
    const titleNorm = nameTokens(info.title).join(" ");
    // Name match: every name token must appear in the channel title.
    if (tokens.length >= 2 && tokens.every((t) => titleNorm.includes(t))) return url;
    // Username match: against the @handle, or the title squashed to alphanumerics.
    if (username) {
      const handleSlug = info.handle?.replace(/^@/, "") ?? "";
      if (handleSlug && usernameMatches(handleSlug, username)) return url;
      const titleSquash = info.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (titleSquash.length >= 4 && (titleSquash.includes(username) || username.includes(titleSquash))) return url;
    }
  }
  return null;
}

// Fetches a channel page and extracts its display title and @handle. Best-effort
// — returns null on any network/parse failure.
async function fetchChannelIdentity(url: string): Promise<{ title: string; handle: string | null } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = (
      html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] ??
      html.match(/<title>([^<]+)<\/title>/i)?.[1] ??
      ""
    )
      .replace(/\s*-\s*YouTube\s*$/i, "")
      .trim();
    const handle =
      html.match(/"canonicalBaseUrl":"\/(@[^"]+)"/)?.[1] ??
      html.match(/youtube\.com\/(@[A-Za-z0-9._-]+)/i)?.[1] ??
      null;
    if (!title && !handle) return null;
    return { title, handle };
  } catch {
    return null;
  }
}

// Strip the tagline IG users tack onto their display name after a separator
// (| • · : – — or a spaced hyphen), plus emoji/symbols, leaving just the name —
// e.g. "Trey Howe | 1% Better Everyday" → "Trey Howe". Empty/undefined → "".
function cleanDisplayName(fullName: string | null | undefined): string {
  if (!fullName) return "";
  return fullName
    .split(/\s*[|•·:]\s*|\s+[–—-]\s+|\n/)[0]
    .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(fullName: string): string[] {
  return fullName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[|·•@()\[\]{}.,'"]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// Normalize an IG username for matching: strip a leading @, lowercase, keep
// alphanumerics only. Returns null if too short to be a useful signal.
function cleanUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return u.length >= 4 ? u : null;
}

// Map Serper organic results to canonical channel URLs, dropping videos/shorts/
// playlists and de-duping. Caps at 10.
function channelCandidates(organic: SerperOrganic[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of organic) {
    const url = extractYouTubeChannelUrl(r.link);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
    if (out.length >= 10) break;
  }
  return out;
}

function pickBestCandidate(candidates: string[], tokens: string[], username: string | null): string | null {
  for (const url of candidates) {
    const slug = extractSlug(url);
    if (!slug) continue; // opaque /channel/UC... ids carry no name signal
    const slugNorm = slug.toLowerCase().replace(/[-_.]/g, " ");
    if (tokens.some((t) => slugNorm.includes(t))) return url;
    if (username && usernameMatches(slug, username)) return url;
  }
  return null;
}

// Compare an IG username to a channel slug, ignoring separators/case. Matches
// when either contains the other (e.g. "pierree" vs "pierree", or
// "gregdoucette" inside "thegregdoucette").
function usernameMatches(slug: string, username: string): boolean {
  const s = slug.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.length < 4) return false;
  return s.includes(username) || username.includes(s);
}

// Returns the name-bearing portion of a channel URL, or null for the opaque
// /channel/UC... form which we can't verify against a name.
function extractSlug(url: string): string | null {
  const m = url.match(/youtube\.com\/(?:@([A-Za-z0-9._-]+)|c\/([A-Za-z0-9._-]+)|user\/([A-Za-z0-9._-]+))/i);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? null;
  return raw ? decodeURIComponent(raw) : null;
}
