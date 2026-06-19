import "server-only";
import type { AppSettings } from "@/lib/types";

const rateLimitedUntil = new Map<string, number>();
const RATE_LIMIT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Round-robin counter — persists across requests within a server process so
// load is spread evenly across all cookies rather than always hitting #1 first.
let rrIndex = 0;

function cookieKey(cookie: string) {
  return cookie.slice(-16);
}

export type PoolEntry = {
  cookie: string;
  proxyUrl: string | null;
  accountUsername: string | null;
};

export function buildCookiePool(settings: AppSettings): PoolEntry[] {
  const seen = new Set<string>();
  const pool: PoolEntry[] = [];

  // Managed accounts — carry their per-account proxy if set
  for (const a of settings.instagram_accounts ?? []) {
    const c = a.cookie?.trim();
    if (c && !seen.has(c)) {
      seen.add(c);
      pool.push({ cookie: c, proxyUrl: a.proxy_url?.trim() || null, accountUsername: a.label ?? null });
    }
  }

  // Legacy multi-cookie list — use global proxy as fallback
  const globalProxy = settings.instagram_proxy_url?.trim() || process.env.INSTAGRAM_PROXY_URL || null;
  for (const c of settings.instagram_session_cookies ?? []) {
    const t = c.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      pool.push({ cookie: t, proxyUrl: globalProxy, accountUsername: null });
    }
  }

  // Legacy single cookie
  const single = (settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE || "").trim();
  if (single && !seen.has(single)) {
    pool.push({ cookie: single, proxyUrl: globalProxy, accountUsername: null });
  }

  return pool;
}

// All unique proxy URLs across every managed account + global fallback.
// Kept separate from the cookie pool so cookies and proxies can rotate
// independently — a dead proxy on one account doesn't strand its cookie.
export function buildProxyPool(settings: AppSettings): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];

  for (const a of settings.instagram_accounts ?? []) {
    const p = a.proxy_url?.trim();
    if (p && !seen.has(p)) { seen.add(p); pool.push(p); }
  }

  const global = settings.instagram_proxy_url?.trim() || process.env.INSTAGRAM_PROXY_URL || "";
  if (global && !seen.has(global)) pool.push(global);

  return pool;
}

// Round-robin pick: start from where we left off, skip rate-limited cookies.
export function pickCookie(pool: PoolEntry[]): PoolEntry | null {
  if (pool.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const idx = (rrIndex + i) % pool.length;
    const entry = pool[idx];
    const exp = rateLimitedUntil.get(cookieKey(entry.cookie));
    if (!exp || now > exp) {
      rrIndex = (idx + 1) % pool.length;
      return entry;
    }
  }
  return null; // all rate-limited
}

export function isRateLimited(cookie: string): boolean {
  const exp = rateLimitedUntil.get(cookieKey(cookie));
  return !!exp && Date.now() < exp;
}

export function markRateLimited(cookie: string) {
  rateLimitedUntil.set(cookieKey(cookie), Date.now() + RATE_LIMIT_TTL_MS);
}

export function availableCookieCount(pool: PoolEntry[]): number {
  const now = Date.now();
  return pool.filter((e) => {
    const exp = rateLimitedUntil.get(cookieKey(e.cookie));
    return !exp || now > exp;
  }).length;
}
