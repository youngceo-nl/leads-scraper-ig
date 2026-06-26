// Reuse the main app's .env.local (same Supabase project, same API keys) so
// credentials live in one place; a worker-local .env can still override.
import { config as loadEnv } from "dotenv";
loadEnv({ path: "../.env.local" });
loadEnv({ path: ".env", override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// .env.local.example documents these vars with blank values (`KEY=`) for
// discoverability — `||` (not `??`) so a blank-but-present var still falls
// back to the default instead of resolving to "" or NaN.
export const config = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  // API keys are normally read from app_settings (DB), matching this repo's
  // existing convention (see lib/config/settings.ts) — these are fallbacks.
  anthropicApiKeyEnv: process.env.ANTHROPIC_API_KEY || null,
  openaiApiKeyEnv: process.env.OPENAI_API_KEY || null,
  // Default provider: OmniVoice-Studio (local voice clone, no API costs).
  // Falls back to "openai" via TTS_PROVIDER=openai before OmniVoice-Studio is
  // installed/running, or if it's ever down.
  ttsProvider: (process.env.TTS_PROVIDER || "omnivoice") as "openai" | "omnivoice",
  // OmniVoice-Studio's backend serves an OpenAI-compatible API at this URL —
  // see docs/agentic-voice.md in https://github.com/debpalash/OmniVoice-Studio.
  omnivoiceStudioUrl: process.env.OMNIVOICE_STUDIO_URL || "http://localhost:3900/v1",
  omnivoiceApiKey: process.env.OMNIVOICE_API_KEY || null, // only needed for a remote backend
  omnivoiceModel: process.env.OMNIVOICE_MODEL || "omnivoice",
  // Voice-profile id from GET /v1/audio/voices — create one in the app first
  // (Settings → Voice Clone, 3s clip of the *owner's own approved voice*,
  // see the compliance constraint in the project plan).
  omnivoiceVoiceId: process.env.OMNIVOICE_VOICE_ID || "default",
  loomSessionDir: process.env.LOOM_SESSION_DIR || "./loom-session",
  pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS || 5000),
  maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS || 3),
  tmpDir: process.env.WORKER_TMP_DIR || "./tmp",
  defaultCtaText: process.env.VIDEO_CTA_TEXT || "I recorded a quick idea for your funnel",
  defaultBrandColor: process.env.VIDEO_BRAND_COLOR || "#286833",
  // The worker runs locally, so the base pitch video is just read straight
  // off disk rather than round-tripped through Supabase Storage — avoids the
  // project's global upload size limit entirely for a large (100MB+) file
  // that never needs to leave this machine. Falls back to the video_assets
  // table (see getBasePitchVideoPath in services/storage.ts) if unset.
  basePitchVideoPath: process.env.BASE_PITCH_VIDEO_PATH || null,
};
