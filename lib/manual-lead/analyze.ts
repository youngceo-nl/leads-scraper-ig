import "server-only";
import { getSettings, resolveScrapingBeeKeys } from "@/lib/config/settings";
import { pickKey, markQuotaExhausted, markRateLimited } from "@/lib/email/key-pool";
import { scrapeProfileWithPostsViaScrapingBee } from "@/lib/scrapingbee/instagram";
import { ScrapingBeeError } from "@/lib/scrapingbee/client";
import { classifyWithOpenAi } from "@/lib/openai/classify";
import { computeMetrics } from "@/lib/pipeline/metrics";
import { computeScores } from "@/lib/scoring/compute";
import { toUsername } from "@/lib/pipeline/normalize";
import type { ClaudeScore, ScrapedProfile } from "@/lib/types";

export type ManualLeadResult =
  | { ok: true; username: string; profile: ScrapedProfile; score: ClaudeScore }
  | { ok: false; username: string; error: string };

export async function analyzeIgLead(input: string): Promise<ManualLeadResult> {
  const username = toUsername(input);
  if (!username) return { ok: false, username: input, error: "Could not parse username from input" };

  const settings = await getSettings();
  const keys = resolveScrapingBeeKeys(settings);
  const apiKey = pickKey("scrapingbee", keys);
  if (!apiKey) return { ok: false, username, error: "No ScrapingBee API keys available (all exhausted)" };

  let profile: ScrapedProfile;
  try {
    const result = await scrapeProfileWithPostsViaScrapingBee({ apiKey, username });
    if (!result) return { ok: false, username, error: "Profile not found or is private" };
    profile = result;
  } catch (err) {
    if (err instanceof ScrapingBeeError) {
      const msg = err.message.toLowerCase();
      if (msg.includes("quota") || msg.includes("credit") || msg.includes("plan_limit")) {
        markQuotaExhausted("scrapingbee", apiKey);
      } else if (err.status === 429) {
        markRateLimited("scrapingbee", apiKey);
      }
    }
    return { ok: false, username, error: err instanceof Error ? err.message : String(err) };
  }

  const openaiKey = settings.openai_api_key || process.env.OPENAI_API_KEY || "";
  if (!openaiKey) return { ok: false, username, error: "OpenAI API key not configured" };

  let classification: Awaited<ReturnType<typeof classifyWithOpenAi>>["classification"];
  try {
    ({ classification } = await classifyWithOpenAi({
      apiKey: openaiKey,
      model: settings.openai_model || "gpt-4o-mini",
      profile,
    }));
  } catch (err) {
    return { ok: false, username, error: `OpenAI classify failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const metrics = computeMetrics(profile);
  const score = computeScores({ profile, metrics, classification, settings });

  return { ok: true, username, profile, score };
}
