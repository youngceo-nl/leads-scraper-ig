import "server-only";
import { getSettings, resolveApifyTokens } from "@/lib/config/settings";
import { scrapeProfiles, scrapePosts } from "@/lib/apify/actors";
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
  const tokens = resolveApifyTokens(settings);
  if (!tokens.length) return { ok: false, username, error: "No Apify token configured — add one in Settings or set APIFY_TOKEN env var" };

  // Scrape profile + posts in parallel — use first available token for posts (runActorSync doesn't rotate)
  let profile: ScrapedProfile;
  try {
    const [profiles, postsMap] = await Promise.all([
      scrapeProfiles({ token: tokens[0], usernames: [username] }),
      scrapePosts({ token: tokens[0], usernames: [username], limit: 12 }),
    ]);

    const raw = profiles[0];
    if (!raw) return { ok: false, username, error: "Profile not found — account may be private or username incorrect" };

    profile = { ...raw, recent_posts: postsMap.get(username) ?? [] };
  } catch (err) {
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
