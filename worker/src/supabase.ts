import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

// Service-role client — mirrors lib/supabase/admin.ts in the main app.
// Bypasses RLS; this process never runs anywhere a browser could reach it.
export function createSupabase() {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Supabase = ReturnType<typeof createSupabase>;

type AppSettingsRow = {
  id: 1;
  claude_api_key: string | null;
  claude_model: string;
  openai_api_key: string | null;
  openai_model: string;
  scoring_provider: "openai" | "claude";
};

let cachedSettings: AppSettingsRow | null = null;

// Same DB-first-then-env convention as lib/config/settings.ts in the main app.
// scoring_provider is reused (not a separate "script provider" setting) so
// script generation tracks whichever LLM the user already configured for lead
// scoring — this app's settings only have an OpenAI key configured today.
export async function getAppSettings(sb: Supabase, force = false): Promise<AppSettingsRow> {
  if (!force && cachedSettings) return cachedSettings;
  const { data, error } = await sb
    .from("app_settings")
    .select("id, claude_api_key, claude_model, openai_api_key, openai_model, scoring_provider")
    .eq("id", 1)
    .single();
  if (error || !data) throw new Error(`Failed to load app_settings: ${error?.message ?? "no row"}`);
  cachedSettings = data as AppSettingsRow;
  return cachedSettings;
}

export function resolveAnthropicKey(s: AppSettingsRow): string {
  const k = s.claude_api_key || process.env.ANTHROPIC_API_KEY || "";
  if (!k) throw new Error("ANTHROPIC_API_KEY not configured (set in Settings or env)");
  return k;
}

export function resolveOpenAiKey(s: AppSettingsRow): string {
  const k = s.openai_api_key || process.env.OPENAI_API_KEY || "";
  if (!k) throw new Error("OPENAI_API_KEY not configured (set in Settings or env)");
  return k;
}
