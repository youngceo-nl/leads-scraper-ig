import "server-only";
import type { RecentPost } from "@/lib/types";

// Free, direct-fetch profile metadata lookup against IG's own
// `web_profile_info` endpoint. Same endpoint our ScrapingBee path hits, just
// without the proxy middleman — so it's $0/profile but uses *your* IP and
// *your* burner-account cookie. Rate-limit / ban your own account if you go
// too fast. Throttling lives in the caller (backfill-metadata.ts), not here.

export class InstagramDirectError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "InstagramDirectError";
  }
}

export type ProfileMetadata = {
  username: string;
  full_name: string | null;
  bio: string | null;
  external_link: string | null;
  followers: number;
  following: number;
  posts: number;
  is_private: boolean;
  is_verified: boolean;
  recent_posts: RecentPost[];
};

type IgPostNode = {
  shortcode?: string;
  is_video?: boolean;
  video_view_count?: number;
  edge_liked_by?: { count?: number };
  edge_media_preview_like?: { count?: number };
  edge_media_to_comment?: { count?: number };
  edge_media_to_caption?: { edges?: { node?: { text?: string } }[] };
  taken_at_timestamp?: number;
};

type IgUser = {
  id?: string;
  username?: string;
  full_name?: string;
  biography?: string;
  external_url?: string;
  is_private?: boolean;
  is_verified?: boolean;
  edge_followed_by?: { count?: number };
  edge_follow?: { count?: number };
  edge_owner_to_timeline_media?: {
    count?: number;
    edges?: { node?: IgPostNode }[];
  };
};

async function igFetch(url: string, init: {
  headers: Record<string, string>;
  method?: string;
  body?: string;
  timeoutMs: number;
  proxyUrl?: string | null;
}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs);
  try {
    if (init.proxyUrl) {
      const { ProxyAgent } = await import("undici");
      const dispatcher = new ProxyAgent(init.proxyUrl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (fetch as any)(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: ctrl.signal, dispatcher });
    }
    return await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchProfileMetadataDirect(opts: {
  username: string;
  sessionCookie?: string | null;
  timeoutMs?: number;
  skipReels?: boolean;
  delayMs?: number;
  proxyUrl?: string | null; // rotating proxy — only used reactively on 429
}): Promise<ProfileMetadata | null> {
  const { username, sessionCookie, timeoutMs = 15_000 } = opts;
  if (opts.delayMs) await sleep(opts.delayMs);
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const headers: Record<string, string> = {
    "User-Agent": randomUA(),
    "X-IG-App-ID": "936619743392459",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${encodeURIComponent(username)}/`,
  };
  if (sessionCookie) headers["Cookie"] = sessionCookie;

  let res: Response;
  try {
    res = await igFetch(url, { headers, timeoutMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InstagramDirectError(`network error: ${msg}`, undefined, true);
  }

  // Hit a 429 — retry once through the rotating proxy if one is configured
  if (res.status === 429 && opts.proxyUrl) {
    try {
      headers["User-Agent"] = randomUA();
      res = await igFetch(url, { headers, timeoutMs, proxyUrl: opts.proxyUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new InstagramDirectError(`proxy retry network error: ${msg}`, undefined, true);
    }
  }

  if (res.status === 404) return null;

  if (res.status === 429) {
    throw new InstagramDirectError(
      "Instagram rate-limited the request (HTTP 429). Slow down or wait.",
      429,
      true,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new InstagramDirectError(
      `Instagram rejected the session cookie (HTTP ${res.status}). Cookie may be expired or account flagged.`,
      res.status,
      false,
    );
  }

  const ctype = res.headers.get("content-type") ?? "";
  const body = await res.text();

  // IG returns HTML for login-walls and challenges, JSON for valid lookups.
  if (!ctype.includes("application/json")) {
    if (body.includes("login") || body.includes("challenge")) {
      throw new InstagramDirectError(
        "Instagram returned a login/challenge page — cookie required or banned.",
        res.status,
        false,
      );
    }
    throw new InstagramDirectError(
      `Unexpected non-JSON response (status ${res.status})`,
      res.status,
      false,
    );
  }

  let parsed: { data?: { user?: IgUser | null } };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InstagramDirectError(
      `Failed to parse JSON response: ${body.slice(0, 200)}`,
      res.status,
      false,
    );
  }

  const user = parsed?.data?.user;
  if (!user || !user.username) return null;

  const timelinePosts: RecentPost[] = (user.edge_owner_to_timeline_media?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is IgPostNode => !!n)
    .map((n) => ({
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
      likes: n.edge_liked_by?.count ?? n.edge_media_preview_like?.count ?? null,
      comments: n.edge_media_to_comment?.count ?? null,
      views: n.is_video ? n.video_view_count ?? null : null,
      taken_at: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000).toISOString() : null,
      is_reel: false,
      is_pinned: false,
    }));

  // Fetch reels separately and merge — reels drive the engagement/activity metric
  // (reels in the last 30 days), so pull enough to cover an active month.
  let reels: RecentPost[] = [];
  if (!opts.skipReels && opts.sessionCookie && user.id) {
    try {
      reels = await fetchReelsDirect({ userId: user.id, sessionCookie: opts.sessionCookie, limit: 12 });
    } catch { /* reels are best-effort */ }
  }

  // Merge: reels first (preserved for the reel count + metrics), then a few
  // timeline posts for captions/keyword matching. Widened past the reel limit
  // so a full month of reels isn't truncated away.
  const recent_posts = [...reels, ...timelinePosts].slice(0, 18);

  return {
    username: user.username.toLowerCase(),
    full_name: user.full_name ?? null,
    bio: user.biography ?? null,
    external_link: user.external_url ?? null,
    followers: user.edge_followed_by?.count ?? 0,
    following: user.edge_follow?.count ?? 0,
    posts: user.edge_owner_to_timeline_media?.count ?? 0,
    is_private: !!user.is_private,
    is_verified: !!user.is_verified,
    recent_posts,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Random integer in [min, max]
function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Realistic User-Agent pool — rotated per-request to avoid fingerprinting on a
// fixed UA string. Mix of browser and official IG app UAs.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Instagram 291.0.0.29.111 Android (30/11; 480dpi; 1080x2137; samsung; SM-G973F; beyond1; exynos9820; en_US; 493494379)",
  "Instagram 317.0.0.24.109 Android (33/13; 420dpi; 1080x2280; samsung; SM-S918B; dm3q; qcom; en_US; 562662939)",
  "Instagram 289.0.0.77.109 Android (28/9; 560dpi; 1440x2960; samsung; SM-G965F; star2qltecs; qcom; en_US; 488165203)",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// =============================================================================
// Fetch the last N unpinned reels for a user via /api/v1/clips/user/
// Returns RecentPost[] with is_reel=true, is_pinned set appropriately.
// Requires a session cookie + the user's numeric IG ID.
// =============================================================================
export async function fetchReelsDirect(opts: {
  userId: string;
  sessionCookie: string;
  limit?: number;
}): Promise<RecentPost[]> {
  const { userId, sessionCookie, limit = 12 } = opts;
  const headers: Record<string, string> = {
    "User-Agent": randomUA(),
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*",
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": sessionCookie,
  };

  const out: RecentPost[] = [];
  let maxId: string | null = null;
  let pages = 0;
  const MAX_PAGES = 4; // page_size is ~9, so this covers the limit with headroom

  while (out.length < limit && pages < MAX_PAGES) {
    pages++;
    const params = new URLSearchParams();
    params.set("target_user_id", userId);
    params.set("page_size", String(Math.min(limit - out.length, 9)));
    params.set("include_feed_video", "true");
    if (maxId) params.set("max_id", maxId);

    const res = await fetch("https://www.instagram.com/api/v1/clips/user/", {
      method: "POST",
      headers,
      body: params.toString(),
    });
    if (!res.ok) break;

    let json: {
      items?: { media?: Record<string, unknown> }[];
      paging_info?: { max_id?: string; more_available?: boolean };
    };
    try { json = await res.json(); } catch { break; }

    const items = json.items ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const media = item.media ?? {};
      const isPinned = !!(media.is_pinned);
      out.push({
        caption: typeof media.caption === "object" && media.caption !== null
          ? String((media.caption as Record<string, unknown>).text ?? "")
          : null,
        likes: typeof media.like_count === "number" ? media.like_count : null,
        comments: typeof media.comment_count === "number" ? media.comment_count : null,
        views: typeof media.play_count === "number" ? media.play_count : null,
        taken_at: typeof media.taken_at === "number"
          ? new Date((media.taken_at as number) * 1000).toISOString()
          : null,
        is_reel: true,
        is_pinned: isPinned,
      });
      if (out.length >= limit) break;
    }

    const more = json.paging_info?.more_available;
    maxId = json.paging_info?.max_id ?? null;
    if (!more || !maxId) break;
    await sleep(jitter(800, 2500));
    headers["User-Agent"] = randomUA();
  }

  return out.slice(0, limit);
}

// =============================================================================
// FREE following-list scraper using the burner session cookie.
// Hits IG's mobile-API `/api/v1/friendships/{user_id}/following/` endpoint,
// paginating with max_id. ~50 results per request. Throttled between pages.
// =============================================================================
export type DiscoveredFollowingDirect = {
  username: string;
  full_name: string | null;
  is_private: boolean;
  is_verified: boolean;
  profile_pic_url: string | null;
  ig_user_id: string | null;
};

type IgFollowingUser = {
  pk?: string | number;
  pk_id?: string;
  username?: string;
  full_name?: string;
  is_private?: boolean;
  is_verified?: boolean;
  profile_pic_url?: string;
};

const FOLLOWING_PAGE_SIZE = 50;
// Jittered delay range between following pages (ms)
const FOLLOWING_DELAY_MIN_MS = 1800;
const FOLLOWING_DELAY_MAX_MS = 4500;
// Backoff on 429 before marking rate-limited
const BACKOFF_MIN_MS = 35_000;
const BACKOFF_MAX_MS = 90_000;
const BACKOFF_MAX_RETRIES = 2;

async function resolveUserIdDirect(opts: {
  username: string;
  sessionCookie: string;
}): Promise<string | null> {
  // Small pre-request delay — looks more human than instant lookup
  await sleep(jitter(300, 900));

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(opts.username)}`;
  const headers: Record<string, string> = {
    "User-Agent": randomUA(),
    "X-IG-App-ID": "936619743392459",
    "Accept": "application/json",
    "Referer": `https://www.instagram.com/${encodeURIComponent(opts.username)}/`,
    "Cookie": opts.sessionCookie,
  };
  let res = await fetch(url, { headers });

  // Retry with backoff on 429 (transient rate-limits often clear in ~30s)
  if (res.status === 429) {
    await sleep(jitter(BACKOFF_MIN_MS, BACKOFF_MAX_MS));
    headers["User-Agent"] = randomUA();
    res = await fetch(url, { headers });
  }

  if (res.status === 429) throw new InstagramDirectError("Rate-limited resolving user_id", 429, true);
  if (res.status === 401 || res.status === 403)
    throw new InstagramDirectError(`Cookie rejected resolving user_id (HTTP ${res.status})`, res.status, false);
  if (res.status === 404) return null;
  const body = await res.text();
  try {
    const j = JSON.parse(body);
    return j?.data?.user?.id ? String(j.data.user.id) : null;
  } catch {
    return null;
  }
}

export async function fetchFollowingDirect(opts: {
  username: string;
  sessionCookie: string;
  limit: number;
  startCursor?: string | null;
}): Promise<{ items: DiscoveredFollowingDirect[]; nextCursor: string | null }> {
  const userId = await resolveUserIdDirect({ username: opts.username, sessionCookie: opts.sessionCookie });
  if (!userId) throw new InstagramDirectError(`Could not resolve user_id for @${opts.username}`, undefined, false);

  const headers: Record<string, string> = {
    "User-Agent": randomUA(),
    "X-IG-App-ID": "936619743392459",
    "Accept": "application/json",
    "Accept-Language": "en-US",
    "Referer": `https://www.instagram.com/${encodeURIComponent(opts.username)}/`,
    "Cookie": opts.sessionCookie,
  };

  const out: DiscoveredFollowingDirect[] = [];
  const seen = new Set<string>();
  let maxId: string | null = opts.startCursor ?? null;
  let pages = 0;
  let nextCursor: string | null = null;

  while (out.length < opts.limit) {
    // Jittered inter-page delay: always sleep between pages so the Inngest
    // per-page-step case also gets throttled (it only fetches one page per call
    // so the old end-of-loop guard never fired for limit=50=PAGE_SIZE).
    if (pages > 0) await sleep(jitter(FOLLOWING_DELAY_MIN_MS, FOLLOWING_DELAY_MAX_MS));
    // Rotate User-Agent each page — prevents fingerprinting on a fixed UA string
    headers["User-Agent"] = randomUA();
    pages++;

    const u = new URL(`https://www.instagram.com/api/v1/friendships/${userId}/following/`);
    u.searchParams.set("count", String(FOLLOWING_PAGE_SIZE));
    if (maxId) u.searchParams.set("max_id", maxId);

    // Fetch with exponential backoff on 429 before giving up
    let res = await fetch(u.toString(), { headers });
    if (res.status === 429) {
      let retries = BACKOFF_MAX_RETRIES;
      while (retries-- > 0 && res.status === 429) {
        await sleep(jitter(BACKOFF_MIN_MS, BACKOFF_MAX_MS));
        headers["User-Agent"] = randomUA();
        res = await fetch(u.toString(), { headers });
      }
    }

    if (res.status === 429)
      throw new InstagramDirectError(`Rate-limited at page ${pages}`, 429, true);
    if (res.status === 401 || res.status === 403)
      throw new InstagramDirectError(`Cookie rejected at page ${pages} (HTTP ${res.status})`, res.status, false);

    const body = await res.text();
    let json: { users?: IgFollowingUser[]; next_max_id?: string };
    try {
      json = JSON.parse(body);
    } catch {
      throw new InstagramDirectError(
        `Non-JSON response at page ${pages}: ${body.slice(0, 200)}`,
        res.status,
        false,
      );
    }
    const users = json.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      if (!u.username) continue;
      const key = u.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        username: key,
        full_name: u.full_name ?? null,
        is_private: !!u.is_private,
        is_verified: !!u.is_verified,
        profile_pic_url: u.profile_pic_url ?? null,
        ig_user_id: u.pk != null ? String(u.pk) : null,
      });
      if (out.length >= opts.limit) break;
    }
    nextCursor = json.next_max_id ?? null;
    if (!nextCursor) break;
    maxId = nextCursor;
  }
  return { items: out.slice(0, opts.limit), nextCursor: out.length >= opts.limit ? nextCursor : null };
}
