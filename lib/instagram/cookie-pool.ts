import "server-only";
import type { AppSettings } from "@/lib/types";

// In-memory rate-limit cache — keyed by last 16 chars of cookie (stable, unique enough).
// Resets on server restart, which is fine — rate limits clear on their own anyway.
const rateLimitedUntil = new Map<string, number>();
const RATE_LIMIT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function cookieKey(cookie: string) {
  return cookie.slice(-16);
}

export function buildCookiePool(settings: AppSettings): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const c of settings.instagram_session_cookies ?? []) {
    const t = c.trim();
    if (t && !seen.has(t)) { seen.add(t); pool.push(t); }
  }
  // Legacy single-cookie field as fallback (for installs that haven't migrated yet)
  const single = (settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE || "").trim();
  if (single && !seen.has(single)) pool.push(single);
  return pool;
}

export function pickCookie(pool: string[]): string | null {
  const now = Date.now();
  for (const c of pool) {
    const exp = rateLimitedUntil.get(cookieKey(c));
    if (!exp || now > exp) return c;
  }
  return null;
}

export function markRateLimited(cookie: string) {
  rateLimitedUntil.set(cookieKey(cookie), Date.now() + RATE_LIMIT_TTL_MS);
}
