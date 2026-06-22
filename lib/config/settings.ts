import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppSettings } from "@/lib/types";

let cached: { value: AppSettings; at: number } | null = null;
const CACHE_MS = 30_000;

export async function getSettings(force = false): Promise<AppSettings> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const sb = createAdminClient();
  const { data, error } = await sb.from("app_settings").select("*").eq("id", 1).single();
  if (error || !data) throw new Error(`Failed to load app_settings: ${error?.message ?? "no row"}`);
  cached = { value: data as AppSettings, at: Date.now() };
  return cached.value;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("app_settings")
    .update(patch)
    .eq("id", 1)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update settings: ${error.message}`);
  cached = { value: data as AppSettings, at: Date.now() };
  return cached.value;
}

// Resolve a key from DB first, env var as fallback.
// Apify is OPTIONAL — required only if `following_scraper_provider` is "apify"
// or "auto" without ScrapingBee configured.
export function resolveApifyToken(s: AppSettings): string | null {
  return process.env.APIFY_TOKEN || s.apify_api_key || null;
}

// Returns all configured tokens (env list first, DB key appended if not already present).
// Used for rotation: caller tries each in order until one succeeds.
export function resolveApifyTokens(s: AppSettings): string[] {
  const fromEnv = (process.env.APIFY_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const fallback = s.apify_api_key?.trim();
  if (fallback && !fromEnv.includes(fallback)) fromEnv.push(fallback);
  if (fromEnv.length === 0) {
    const single = process.env.APIFY_TOKEN?.trim();
    if (single) fromEnv.push(single);
  }
  return fromEnv;
}
export function resolveClaudeKey(s: AppSettings): string {
  const k = s.claude_api_key || process.env.ANTHROPIC_API_KEY || "";
  if (!k) throw new Error("ANTHROPIC_API_KEY not configured (set in Settings or env)");
  return k;
}

// Returns all configured ScrapingBee keys for rotation.
// SCRAPINGBEE_API_KEYS (comma-separated) > SCRAPINGBEE_API_KEY (single) > DB key.
export function resolveScrapingBeeKeys(s: AppSettings): string[] {
  const fromEnv = (process.env.SCRAPINGBEE_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const single = process.env.SCRAPINGBEE_API_KEY?.trim();
  if (single && !fromEnv.includes(single)) fromEnv.push(single);
  for (const k of s.scrapingbee_api_keys ?? []) {
    const t = k.trim();
    if (t && !fromEnv.includes(t)) fromEnv.push(t);
  }
  const dbKey = s.scrapingbee_api_key?.trim();
  if (dbKey && !fromEnv.includes(dbKey)) fromEnv.push(dbKey);
  return fromEnv;
}
