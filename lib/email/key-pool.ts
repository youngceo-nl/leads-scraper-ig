// Generic rotating API key pool for free-tier email finder accounts.
// Same pattern as lib/instagram/cookie-pool.ts — round-robin with skip-on-exhaust.
//
// Two tiers of backoff:
//   rate_limited  → skip for 1h   (per-minute API cap hit)
//   quota_exceeded → skip for 30d  (monthly free-tier quota exhausted)

const unavailableUntil = new Map<string, number>();
const RATE_LIMIT_TTL_MS = 60 * 60 * 1000;        // 1 hour
const QUOTA_EXHAUSTED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const rrIndex: Record<string, number> = {};

function keyId(provider: string, key: string) {
  return `${provider}:${key.slice(-12)}`;
}

export function pickKey(provider: string, keys: string[]): string | null {
  if (!keys.length) return null;
  const now = Date.now();
  const base = rrIndex[provider] ?? 0;
  for (let i = 0; i < keys.length; i++) {
    const idx = (base + i) % keys.length;
    const key = keys[idx];
    const exp = unavailableUntil.get(keyId(provider, key));
    if (!exp || now > exp) {
      rrIndex[provider] = (idx + 1) % keys.length;
      return key;
    }
  }
  return null; // all keys exhausted
}

export function markRateLimited(provider: string, key: string) {
  unavailableUntil.set(keyId(provider, key), Date.now() + RATE_LIMIT_TTL_MS);
}

export function markQuotaExhausted(provider: string, key: string) {
  unavailableUntil.set(keyId(provider, key), Date.now() + QUOTA_EXHAUSTED_TTL_MS);
}

export function availableKeyCount(provider: string, keys: string[]): number {
  const now = Date.now();
  return keys.filter((k) => {
    const exp = unavailableUntil.get(keyId(provider, k));
    return !exp || now > exp;
  }).length;
}

// Reasons that indicate monthly quota is gone (not just a per-minute rate limit)
const QUOTA_REASONS = ["quota_exceeded", "credits_exhausted", "plan_limit", "insufficient_credits", "no_credits"];

export function isQuotaReason(reason: string): boolean {
  return QUOTA_REASONS.some((r) => reason.toLowerCase().includes(r));
}
