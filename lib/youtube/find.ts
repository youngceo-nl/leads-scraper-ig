import "server-only";
import { serperSearch, SerperError, type SerperOrganic } from "@/lib/serper/client";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";

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
  const tokens = opts.fullName ? nameTokens(opts.fullName) : [];
  const username = cleanUsername(opts.username);

  let query: string;
  let matchUser: string | null = null;
  if (tokens.length >= 2) {
    const hint = (opts.hints ?? "").trim().slice(0, 80);
    query = `"${opts.fullName!.trim()}"${hint ? " " + hint : ""} site:youtube.com`;
  } else if (username) {
    // Single-name (or nameless) lead: look the IG handle up on YouTube.
    query = `"${username}" site:youtube.com`;
    matchUser = username;
  } else {
    return { url: null, candidates: [], error: "skipped:no_name_or_username" };
  }

  let organic: SerperOrganic[] = [];
  try {
    const r = await serperSearch({ apiKey: opts.apiKey, query, num: 10, retries: 1 });
    organic = r.organic;
  } catch (err) {
    const msg = err instanceof SerperError ? err.message : (err as Error).message;
    return { url: null, candidates: [], error: `serp_failed: ${msg.slice(0, 200)}` };
  }

  const candidates = channelCandidates(organic);
  if (candidates.length === 0) {
    return { url: null, candidates: [], error: "no_serp_match" };
  }

  const matched = pickBestCandidate(candidates, tokens, matchUser);
  if (!matched) {
    return { url: null, candidates, error: "no_name_overlap" };
  }
  return { url: matched, candidates, error: null };
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
