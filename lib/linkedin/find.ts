import "server-only";
import { serperSearch, SerperError, type SerperOrganic } from "@/lib/serper/client";

export type LinkedInLookupResult = {
  url: string | null;
  candidates: string[];
  error: string | null;
};

/**
 * Find a person's LinkedIn profile via Serper.dev (Google Search API). Reads the
 * structured `organic` results, keeps /in/ profile URLs, and returns the first
 * whose handle overlaps the person's name.
 */
export async function findLinkedInUrl(opts: {
  apiKey: string;
  fullName?: string | null;
  username?: string | null;
  hints?: string | null;
}): Promise<LinkedInLookupResult> {
  const tokens = opts.fullName ? nameTokens(opts.fullName) : [];
  const username = cleanUsername(opts.username);

  let query: string;
  let matchUser: string | null = null;
  if (tokens.length >= 2) {
    const hint = (opts.hints ?? "").trim().slice(0, 80);
    query = `"${opts.fullName!.trim()}"${hint ? " " + hint : ""} site:linkedin.com/in`;
  } else if (username) {
    // Single-name (or nameless) lead: look the IG handle up on LinkedIn.
    query = `"${username}" site:linkedin.com/in`;
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

  const candidates = profileCandidates(organic);
  if (candidates.length === 0) {
    return { url: null, candidates: [], error: "no_serp_match" };
  }

  const matched = pickBestCandidate(candidates, tokens, matchUser);
  if (!matched) {
    return { url: null, candidates, error: "no_name_overlap" };
  }
  return { url: matched, candidates, error: null };
}

// Normalize an IG username for matching: strip a leading @, lowercase, keep
// alphanumerics only. Returns null if too short to be a useful signal.
function cleanUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return u.length >= 4 ? u : null;
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

// Pull /in/ profile URLs out of Serper organic results, strip tracking, dedupe.
function profileCandidates(organic: SerperOrganic[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i;
  for (const r of organic) {
    const link = r.link ?? "";
    const m = link.match(re);
    if (!m) continue;
    const cleaned = stripTracking(m[0]);
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
    if (out.length >= 10) break;
  }
  return out;
}

function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function pickBestCandidate(candidates: string[], tokens: string[], username: string | null): string | null {
  for (const url of candidates) {
    const handle = extractHandle(url);
    if (!handle) continue;
    const handleNorm = handle.toLowerCase().replace(/-/g, " ");
    if (tokens.some((t) => handleNorm.includes(t))) return url;
    if (username) {
      const h = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (h.length >= 4 && (h.includes(username) || username.includes(h))) return url;
    }
  }
  return null;
}

function extractHandle(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}
