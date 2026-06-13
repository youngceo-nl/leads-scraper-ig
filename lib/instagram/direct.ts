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

export async function fetchProfileMetadataDirect(opts: {
  username: string;
  sessionCookie?: string | null;
  timeoutMs?: number;
}): Promise<ProfileMetadata | null> {
  const { username, sessionCookie, timeoutMs = 15_000 } = opts;
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "X-IG-App-ID": "936619743392459",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${encodeURIComponent(username)}/`,
  };
  if (sessionCookie) headers["Cookie"] = sessionCookie;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    throw new InstagramDirectError(`network error: ${msg}`, undefined, true);
  }
  clearTimeout(t);

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

  const recent_posts: RecentPost[] = (user.edge_owner_to_timeline_media?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is IgPostNode => !!n)
    .map((n) => ({
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
      likes: n.edge_liked_by?.count ?? n.edge_media_preview_like?.count ?? null,
      comments: n.edge_media_to_comment?.count ?? null,
      views: n.is_video ? n.video_view_count ?? null : null,
      taken_at: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000).toISOString() : null,
    }));

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
const FOLLOWING_DELAY_MS = 2500;

async function resolveUserIdDirect(opts: {
  username: string;
  sessionCookie: string;
}): Promise<string | null> {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(opts.username)}`;
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "X-IG-App-ID": "936619743392459",
    "Accept": "application/json",
    "Referer": `https://www.instagram.com/${encodeURIComponent(opts.username)}/`,
    "Cookie": opts.sessionCookie,
  };
  const res = await fetch(url, { headers });
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
}): Promise<DiscoveredFollowingDirect[]> {
  const userId = await resolveUserIdDirect({ username: opts.username, sessionCookie: opts.sessionCookie });
  if (!userId) throw new InstagramDirectError(`Could not resolve user_id for @${opts.username}`, undefined, false);

  const headers: Record<string, string> = {
    "User-Agent":
      "Instagram 291.0.0.29.111 Android (30/11; 480dpi; 1080x2137; samsung; SM-G973F; beyond1; exynos9820; en_US; 493494379)",
    "X-IG-App-ID": "936619743392459",
    "Accept": "application/json",
    "Accept-Language": "en-US",
    "Referer": `https://www.instagram.com/${encodeURIComponent(opts.username)}/`,
    "Cookie": opts.sessionCookie,
  };

  const out: DiscoveredFollowingDirect[] = [];
  const seen = new Set<string>();
  let maxId: string | null = null;
  let pages = 0;

  while (out.length < opts.limit) {
    const u = new URL(`https://www.instagram.com/api/v1/friendships/${userId}/following/`);
    u.searchParams.set("count", String(FOLLOWING_PAGE_SIZE));
    if (maxId) u.searchParams.set("max_id", maxId);

    const res = await fetch(u.toString(), { headers });
    pages++;

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
    if (!json.next_max_id) break;
    maxId = json.next_max_id;
    if (out.length < opts.limit) await sleep(FOLLOWING_DELAY_MS);
  }
  return out.slice(0, opts.limit);
}
