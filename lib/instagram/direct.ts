import "server-only";
import type { RecentPost } from "@/lib/types";
import { BrowserSession, randomUA } from "@/lib/instagram/browser-fetch";

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

// Routes through Chrome's real TLS/HTTP2 stack when a browser session is
// provided, falls back to Node.js fetch otherwise (no-cookie probes, etc.).
async function igFetch(
  url: string,
  init: {
    headers: Record<string, string>;
    method?: string;
    body?: string;
    timeoutMs: number;
    proxyUrl?: string | null;
    session?: BrowserSession | null;
  },
): Promise<{ status: number; body: string }> {
  if (init.session) {
    return init.session.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeoutMs: init.timeoutMs,
    });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs);
  try {
    let res: Response;
    if (init.proxyUrl) {
      const { ProxyAgent } = await import("undici");
      const dispatcher = new ProxyAgent(init.proxyUrl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res = await (fetch as any)(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: ctrl.signal, dispatcher });
    } else {
      res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: ctrl.signal });
    }
    return { status: res.status, body: await res.text() };
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
  proxyUrl?: string | null;
  // Pass an external BrowserSession to amortise Chrome startup across multiple
  // profiles (e.g. a batch in backfill-metadata). When provided the session is
  // NOT closed here — the caller owns the lifecycle.
  session?: BrowserSession | null;
}): Promise<ProfileMetadata | null> {
  const { username, sessionCookie, timeoutMs = 15_000 } = opts;
  if (opts.delayMs) await sleep(opts.delayMs);

  const externalSession = opts.session ?? null;

  // Only auto-create a BrowserSession when the caller omitted `session` entirely
  // (undefined). Passing `session: null` explicitly means "use Node.js fetch" —
  // useful for batch backfill where undici + ProxyAgent is faster and more reliable.
  const ownSession = opts.session === undefined && sessionCookie ? new BrowserSession() : null;
  if (ownSession) await ownSession.init(sessionCookie!, opts.proxyUrl);

  const session = externalSession ?? ownSession;
  try {
    return await _fetchProfileMetadata({ username, sessionCookie, timeoutMs, skipReels: opts.skipReels, proxyUrl: opts.proxyUrl, session });
  } finally {
    await ownSession?.close(); // only close if we created it
  }
}

async function _fetchProfileMetadata(opts: {
  username: string;
  sessionCookie?: string | null;
  timeoutMs: number;
  skipReels?: boolean;
  proxyUrl?: string | null;
  session: BrowserSession | null;
}): Promise<ProfileMetadata | null> {
  const { username, sessionCookie, timeoutMs, session } = opts;
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const ua = randomUA();
  const referer = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const headers: Record<string, string> = sessionCookie
    ? chromeHeaders(ua, sessionCookie, referer)
    : { "User-Agent": ua, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "X-IG-App-ID": "936619743392459", "Referer": referer };

  let res: { status: number; body: string };
  try {
    res = await igFetch(url, { headers, timeoutMs, session });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InstagramDirectError(`network error: ${msg}`, undefined, true);
  }

  // Hit a 429 without a session — retry once through the rotating proxy
  if (res.status === 429 && opts.proxyUrl && !session) {
    try {
      res = await igFetch(url, { headers, timeoutMs, proxyUrl: opts.proxyUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new InstagramDirectError(`proxy retry network error: ${msg}`, undefined, true);
    }
  }

  if (res.status === 404) return null;
  if (res.status === 407) {
    throw new InstagramDirectError(
      `Proxy authentication failed (HTTP 407) — check proxy credentials for this account.`,
      407,
      false,
    );
  }
  if (res.status === 429) {
    throw new InstagramDirectError("Instagram rate-limited the request (HTTP 429). Slow down or wait.", 429, true);
  }
  if (res.status === 401 || res.status === 403) {
    throw new InstagramDirectError(
      `Instagram rejected the session cookie (HTTP ${res.status}). Cookie may be expired or account flagged.`,
      res.status,
      false,
    );
  }

  const { body } = res;
  // IG returns HTML for login-walls and challenges, JSON for valid lookups.
  if (!body.trimStart().startsWith("{")) {
    if (body.includes("login") || body.includes("challenge")) {
      throw new InstagramDirectError(
        "Instagram returned a login/challenge page — cookie required or banned.",
        res.status,
        false,
      );
    }
    throw new InstagramDirectError(`Unexpected non-JSON response (status ${res.status})`, res.status, false);
  }

  let parsed: { data?: { user?: IgUser | null } };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InstagramDirectError(`Failed to parse JSON response: ${body.slice(0, 200)}`, res.status, false);
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

  let reels: RecentPost[] = [];
  if (!opts.skipReels && sessionCookie && user.id) {
    try {
      reels = await fetchReelsDirect({ userId: user.id, sessionCookie, limit: 12, session });
    } catch { /* reels are best-effort */ }
  }

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

// Extract the sec-ch-ua hint matching the chosen UA (Chrome version)
function secChUa(ua: string): string {
  const m = ua.match(/Chrome\/(\d+)/);
  const v = m?.[1] ?? "124";
  return `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not-A.Brand";v="99"`;
}

function platform(ua: string): string {
  return ua.includes("Windows") ? "Windows" : "macOS";
}

// Extract csrftoken from a cookie string so it can be sent as X-CSRFToken
function extractCsrf(cookie: string): string | null {
  const m = cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m?.[1] ?? null;
}

// Full set of headers a real Chrome browser sends to Instagram's API
function chromeHeaders(ua: string, cookie: string, referer: string): Record<string, string> {
  const csrf = extractCsrf(cookie);
  return {
    "User-Agent": ua,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-IG-WWW-Claim": "0",
    "X-Requested-With": "XMLHttpRequest",
    ...(csrf ? { "X-CSRFToken": csrf } : {}),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "sec-ch-ua": secChUa(ua),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${platform(ua)}"`,
    "Origin": "https://www.instagram.com",
    "Referer": referer,
    "Cookie": cookie,
  };
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
  session?: BrowserSession | null;
}): Promise<RecentPost[]> {
  const { userId, sessionCookie, limit = 12, session = null } = opts;

  const out: RecentPost[] = [];
  let maxId: string | null = null;
  let pages = 0;
  const MAX_PAGES = 4;

  while (out.length < limit && pages < MAX_PAGES) {
    pages++;
    const headers = {
      ...chromeHeaders(randomUA(), sessionCookie, "https://www.instagram.com/reels/"),
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const params = new URLSearchParams();
    params.set("target_user_id", userId);
    params.set("page_size", String(Math.min(limit - out.length, 9)));
    params.set("include_feed_video", "true");
    if (maxId) params.set("max_id", maxId);

    const res = await igFetch("https://www.instagram.com/api/v1/clips/user/", {
      method: "POST",
      headers,
      body: params.toString(),
      timeoutMs: 15_000,
      session,
    });
    if (res.status < 200 || res.status >= 300) break;

    let json: {
      items?: { media?: Record<string, unknown> }[];
      paging_info?: { max_id?: string; more_available?: boolean };
    };
    try { json = JSON.parse(res.body); } catch { break; }

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
  session: BrowserSession | null;
}): Promise<string | null> {
  await sleep(jitter(300, 900));

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(opts.username)}`;
  const referer = `https://www.instagram.com/${encodeURIComponent(opts.username)}/`;

  let res = await igFetch(url, {
    headers: chromeHeaders(randomUA(), opts.sessionCookie, referer),
    timeoutMs: 15_000,
    session: opts.session,
  });

  if (res.status === 429) {
    await sleep(jitter(BACKOFF_MIN_MS, BACKOFF_MAX_MS));
    res = await igFetch(url, {
      headers: chromeHeaders(randomUA(), opts.sessionCookie, referer),
      timeoutMs: 15_000,
      session: opts.session,
    });
  }

  if (res.status === 429) throw new InstagramDirectError("Rate-limited resolving user_id", 429, true);
  if (res.status === 401 || res.status === 403)
    throw new InstagramDirectError(`Cookie rejected resolving user_id (HTTP ${res.status})`, res.status, false);
  if (res.status === 404) return null;
  try {
    const j = JSON.parse(res.body);
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
  // One browser session for the whole paginated scrape — Chrome start cost is
  // paid once and amortised across all page requests.
  const session = new BrowserSession();
  await session.init(opts.sessionCookie);
  try {
    return await _fetchFollowingPages({ ...opts, session });
  } finally {
    await session.close();
  }
}

async function _fetchFollowingPages(opts: {
  username: string;
  sessionCookie: string;
  limit: number;
  startCursor?: string | null;
  session: BrowserSession;
}): Promise<{ items: DiscoveredFollowingDirect[]; nextCursor: string | null }> {
  const { session } = opts;
  const userId = await resolveUserIdDirect({ username: opts.username, sessionCookie: opts.sessionCookie, session });
  if (!userId) throw new InstagramDirectError(`Could not resolve user_id for @${opts.username}`, undefined, false);

  const referer = `https://www.instagram.com/${encodeURIComponent(opts.username)}/following/`;
  const out: DiscoveredFollowingDirect[] = [];
  const seen = new Set<string>();
  let maxId: string | null = opts.startCursor ?? null;
  let pages = 0;
  let nextCursor: string | null = null;

  while (out.length < opts.limit) {
    if (pages > 0) await sleep(jitter(FOLLOWING_DELAY_MIN_MS, FOLLOWING_DELAY_MAX_MS));
    pages++;

    const u = new URL(`https://www.instagram.com/api/v1/friendships/${userId}/following/`);
    u.searchParams.set("count", String(FOLLOWING_PAGE_SIZE));
    if (maxId) u.searchParams.set("max_id", maxId);

    let res = await igFetch(u.toString(), {
      headers: chromeHeaders(randomUA(), opts.sessionCookie, referer),
      timeoutMs: 15_000,
      session,
    });

    if (res.status === 429) {
      let retries = BACKOFF_MAX_RETRIES;
      while (retries-- > 0 && res.status === 429) {
        await sleep(jitter(BACKOFF_MIN_MS, BACKOFF_MAX_MS));
        res = await igFetch(u.toString(), {
          headers: chromeHeaders(randomUA(), opts.sessionCookie, referer),
          timeoutMs: 15_000,
          session,
        });
      }
    }

    if (res.status === 429)
      throw new InstagramDirectError(`Rate-limited at page ${pages}`, 429, true);
    if (res.status === 401 || res.status === 403)
      throw new InstagramDirectError(`Cookie rejected at page ${pages} (HTTP ${res.status})`, res.status, false);

    let json: { users?: IgFollowingUser[]; next_max_id?: string };
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new InstagramDirectError(
        `Non-JSON response at page ${pages}: ${res.body.slice(0, 200)}`,
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
