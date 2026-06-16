import dns from "dns";
import { promisify } from "util";

const resolveMx = promisify(dns.resolveMx);

export type DomainInferenceResult =
  | { email: string; domain: string; pattern: string; hasMx: true }
  | { email: null; reason: string; hasMx: boolean };

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    // Skip known link-in-bio aggregators and social platforms — not the person's own domain
    const blocklist = ["linktree.com", "beacons.ai", "bio.link", "linktr.ee", "stan.store",
      "instagram.com", "youtube.com", "tiktok.com", "twitter.com", "x.com",
      "facebook.com", "linkedin.com", "taplink.cc", "koji.to", "campsite.bio"];
    if (blocklist.some((b) => host === b || host.endsWith("." + b))) return null;
    return host;
  } catch {
    return null;
  }
}

function parseName(fullName: string | null | undefined): { first: string; last: string | null } | null {
  const tokens = (fullName ?? "")
    .trim()
    // Strip common brand suffixes: "John Smith | Coaching" → "John Smith"
    .split(/[|·•—–]/)[0]
    .trim()
    .split(/\s+/)
    .filter((t) => /^[a-zA-Z'-]{2,}$/.test(t));
  if (!tokens.length) return null;
  return {
    first: tokens[0].toLowerCase(),
    last: tokens.length > 1 ? tokens[tokens.length - 1].toLowerCase() : null,
  };
}

// Returns candidates ordered by likelihood (most common patterns first).
function buildCandidates(domain: string, first: string, last: string | null): string[] {
  const out: string[] = [];
  out.push(`${first}@${domain}`);
  if (last && last !== first) {
    out.push(`${first}.${last}@${domain}`);
    out.push(`${first}${last}@${domain}`);
    out.push(`${first[0]}${last}@${domain}`);
  }
  return out;
}

export async function inferEmailFromDomain(opts: {
  externalLink: string | null | undefined;
  fullName: string | null | undefined;
}): Promise<DomainInferenceResult> {
  const domain = extractDomain(opts.externalLink);
  if (!domain) return { email: null, reason: "no_personal_domain", hasMx: false };

  // DNS MX lookup: if the domain has no mail server, email addresses are pointless.
  let hasMx = false;
  try {
    const mx = await resolveMx(domain);
    hasMx = mx.length > 0;
  } catch {
    hasMx = false;
  }
  if (!hasMx) return { email: null, reason: `no_mx_records(${domain})`, hasMx: false };

  const name = parseName(opts.fullName);
  if (!name) return { email: null, reason: "no_parseable_name", hasMx: true };

  const candidates = buildCandidates(domain, name.first, name.last);
  const best = candidates[0];
  const pattern = name.last
    ? `{first}@{domain}`
    : `{first}@{domain}`;

  return { email: best, domain, pattern, hasMx: true };
}
