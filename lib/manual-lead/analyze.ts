import "server-only";
import { getSettings, resolveApifyTokens } from "@/lib/config/settings";
import { scrapeProfiles, scrapePosts } from "@/lib/apify/actors";
import { classifyWithOpenAi } from "@/lib/openai/classify";
import { computeMetrics } from "@/lib/pipeline/metrics";
import { computeScores } from "@/lib/scoring/compute";
import { persistLead } from "@/lib/pipeline/persist";
import { toUsername } from "@/lib/pipeline/normalize";
import { testingEnrichPipeline } from "@/lib/pipeline/testing-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ClaudeScore, ScrapedProfile } from "@/lib/types";

export type ManualLeadResult =
  | { ok: true; username: string; profile: ScrapedProfile; score: ClaudeScore }
  | { ok: false; username: string; error: string; duplicate?: true };

export async function analyzeIgLead(input: string, source: string = "manual_api"): Promise<ManualLeadResult> {
  const username = toUsername(input);
  if (!username) return { ok: false, username: input, error: "Could not parse username from input" };

  const sb = createAdminClient();
  const { data: existing } = await sb
    .from("leads")
    .select("status, overall_score")
    .eq("username", username)
    .single();
  if (existing) {
    return {
      ok: false,
      duplicate: true,
      username,
      error: `Already in DB — ${existing.overall_score ?? "unscored"}/10 (${existing.status})`,
    };
  }

  const settings = await getSettings();
  const tokens = resolveApifyTokens(settings);
  if (!tokens.length) return { ok: false, username, error: "No Apify token configured — add one in Settings or set APIFY_TOKEN env var" };

  // Scrape profile + posts in parallel — use first available token for posts (runActorSync doesn't rotate)
  let profile: ScrapedProfile;
  try {
    const profiles = await scrapeProfiles({ token: tokens, usernames: [username] });
    const raw = profiles[0];
    if (!raw) return { ok: false, username, error: "Profile not found — account may be private or username incorrect" };

    const postsMap = await scrapePosts({ token: tokens, usernames: [username], limit: 12 });
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

  const status = score.recommended_action === "qualified" ? "qualified"
    : score.recommended_action === "review" ? "review"
    : "rejected";

  const persisted = await persistLead({
    profile,
    metrics,
    score,
    status,
    rejection_reason: status === "rejected" ? score.reason_for_score : null,
    crawl_depth: 0,
    source_seed_id: null,
    parent_username: null,
    lead_source: source,
  });

  if (status === "qualified") {
    await testingEnrichPipeline({ leadId: persisted.id });
  }

  return { ok: true, username, profile, score };
}
