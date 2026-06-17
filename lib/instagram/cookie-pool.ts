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

export function buildCookiePool(settings: AppSettings): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const a of settings.instagram_accounts ?? []) {
    const c = a.cookie?.trim();
    if (c && !seen.has(c)) { seen.add(c); pool.push(c); }
  }
  for (const c of settings.instagram_session_cookies ?? []) {
    const t = c.trim();
    if (t && !seen.has(t)) { seen.add(t); pool.push(t); }
  }
  const single = (settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE || "").trim();
  if (single && !seen.has(single)) pool.push(single);
  return pool;
}

// Round-robin pick: start from where we left off, skip rate-limited cookies.
export function pickCookie(pool: string[]): string | null {
  if (pool.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const idx = (rrIndex + i) % pool.length;
    const cookie = pool[idx];
    const exp = rateLimitedUntil.get(cookieKey(cookie));
    if (!exp || now > exp) {
      rrIndex = (idx + 1) % pool.length; // advance for next caller
      return cookie;
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

export function availableCookieCount(pool: string[]): number {
  const now = Date.now();
  return pool.filter((c) => {
    const exp = rateLimitedUntil.get(cookieKey(c));
    return !exp || now > exp;
  }).length;
}
