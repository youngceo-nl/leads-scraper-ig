// Extracts a human-readable program name from a URL without any network calls.
// Used as a zero-cost fallback when page fetching is unavailable or fails.

const PLATFORM_HOSTS = new Set([
  "linktr.ee", "linktree.com",
  "stan.store",
  "beacons.ai", "beacons.page",
  "whop.com",
  "bio.link", "lnk.bio", "linkin.bio",
  "snipfeed.co", "tap.bio", "campsite.bio",
  "allmylinks.com", "bento.me", "flowpage.com", "solo.to",
  "msha.ke", "later.com",
]);

const GENERIC_PATH_SEGMENTS = new Set([
  "free-training", "free-course", "free-masterclass", "free-guide",
  "course", "courses", "training", "webinar", "masterclass", "workshop",
  "free", "start", "home", "about", "contact", "blog", "shop", "store",
  "optin", "opt-in", "access", "checkout", "buy", "enroll",
]);

export function extractProgramNameFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }

  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();

  // YouTube: split the @handle on camelCase boundaries
  if (hostname === "youtube.com" || hostname === "youtu.be") {
    const handle = url.pathname.match(/@([^/]+)/)?.[1];
    if (handle) return splitCamelCase(handle);
    return null;
  }

  // Known aggregator/platform: try to get something from the path slug
  const domain2 = hostname.split(".").slice(-2).join(".");
  if (PLATFORM_HOSTS.has(domain2) || PLATFORM_HOSTS.has(hostname)) {
    if (domain2 === "whop.com") {
      // e.g. whop.com/trader-u-chepeex → "Trader U Chepeex"
      const slug = url.pathname.replace(/^\//, "").split("/")[0];
      if (slug && !GENERIC_PATH_SEGMENTS.has(slug)) return slugToTitle(slug);
    }
    return null;
  }

  // Brand TLDs: the TLD is part of the name and should be kept as a word
  // e.g. "travelpreneur.university" → "Travelpreneur University"
  const BRAND_TLDS: Record<string, string> = {
    ".university": "University",
    ".education": "Education",
    ".institute": "Institute",
    ".media": "Media",
    ".studio": "Studio",
  };
  for (const [tld, word] of Object.entries(BRAND_TLDS)) {
    if (hostname.endsWith(tld)) {
      const stem = hostname.slice(0, -tld.length);
      if (stem) return `${stem.includes("-") ? slugToTitle(stem) : splitCamelCase(stem)} ${word}`;
    }
  }

  // Personal domain: strip TLD(s) and format
  let name = hostname;
  // Strip common TLDs (multi-word first to avoid partial matches)
  for (const tld of [".co.uk", ".com.au", ".co.nz", ".academy", ".online", ".store",
    ".com", ".co", ".io", ".net", ".org", ".info", ".biz", ".me", ".app", ".xyz"]) {
    if (name.endsWith(tld)) { name = name.slice(0, -tld.length); break; }
  }

  if (!name) return null;

  // Hyphenated domain → split on hyphens
  if (name.includes("-")) return slugToTitle(name);

  // No hyphens: try camelCase split, otherwise just title-case the whole thing
  const camel = splitCamelCase(name);
  return camel;
}

function slugToTitle(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Splits "TheAIClubhouse" → "The AI Clubhouse", "mrfreevalue" → "Mrfreevalue"
// (lowercase strings without natural splits stay as-is; that's OK as a last resort)
function splitCamelCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
