"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";
import { inngest } from "@/inngest/client";
import { getSettings } from "@/lib/config/settings";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

function parseLimit(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export async function addSeed(formData: FormData) {
  await requireUser();
  const raw = String(formData.get("input") ?? "").trim();
  if (!raw) return { error: "Empty input" };
  const username = toUsername(raw);
  if (!username) return { error: "Invalid username/URL" };
  const max_profiles_to_scrape = parseLimit(formData.get("max_profiles_to_scrape"));

  const sb = createAdminClient();
  const { error } = await sb.from("seeds").insert({
    username,
    profile_url: profileUrl(username),
    max_profiles_to_scrape,
  });
  if (error && !error.message.includes("duplicate")) return { error: error.message };

  revalidatePath("/seeds");
  return { ok: true };
}

export async function updateSeedLimit(id: string, max_profiles_to_scrape: number | null) {
  await requireUser();
  const value =
    max_profiles_to_scrape != null && Number.isFinite(max_profiles_to_scrape) && max_profiles_to_scrape > 0
      ? Math.floor(max_profiles_to_scrape)
      : null;
  const sb = createAdminClient();
  const { error } = await sb.from("seeds").update({ max_profiles_to_scrape: value }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/seeds");
  return { ok: true };
}

export async function deleteSeed(id: string) {
  await requireUser();
  const sb = createAdminClient();
  await sb.from("seeds").delete().eq("id", id);
  revalidatePath("/seeds");
}

export async function startCrawl(seed_id: string) {
  await requireUser();
  const admin = createAdminClient();
  const { data: seed } = await admin
    .from("seeds")
    .select("id, username, max_profiles_to_scrape")
    .eq("id", seed_id)
    .single();
  if (!seed) return { error: "seed_not_found" };

  const settings = await getSettings(true);

  // Pre-flight: validate that at least one viable scrape provider is configured
  // for the seed's first hop, plus a scoring provider with a key.
  const apifyOk = !!(settings.apify_api_key || process.env.APIFY_TOKEN);
  const sbOk = !!(settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY);
  const sbCookieOk = !!(settings.instagram_session_cookie || process.env.INSTAGRAM_SESSION_COOKIE);
  const followingProvider = settings.following_scraper_provider;
  if (followingProvider === "apify" && !apifyOk) {
    return { error: "Apify is selected but no Apify API key is set. Add one in Settings." };
  }
  if (followingProvider === "scrapingbee" && !(sbOk && sbCookieOk)) {
    return { error: "ScrapingBee is selected but missing API key or Instagram session cookie. Add them in Settings." };
  }
  if (followingProvider === "cookie" && !sbCookieOk) {
    return { error: "Cookie-only is selected but no Instagram session cookie is set. Add one in Settings." };
  }
  if (followingProvider === "auto" && !apifyOk && !(sbOk && sbCookieOk)) {
    return { error: "No scrape provider configured. Add an Apify key, or a ScrapingBee key + Instagram cookie, in Settings." };
  }

  const scoring = settings.scoring_provider;
  if (scoring === "claude" && !(settings.claude_api_key || process.env.ANTHROPIC_API_KEY)) {
    return { error: "Claude is the scoring provider but no Anthropic API key is set. Add one in Settings." };
  }
  if (scoring === "openai" && !(settings.openai_api_key || process.env.OPENAI_API_KEY)) {
    return { error: "OpenAI is the scoring provider but no OpenAI API key is set. Add one in Settings." };
  }

  const { data: job, error: jobErr } = await admin
    .from("crawl_jobs")
    .insert({ seed_id: seed.id, status: "queued", max_depth: settings.max_crawl_depth })
    .select("id")
    .single();
  if (jobErr || !job) return { error: jobErr?.message ?? "job_create_failed" };

  const { ids } = await inngest.send({
    name: "crawl/seed.requested",
    data: {
      crawl_job_id: job.id,
      seed_id: seed.id,
      seed_username: seed.username,
      profile_limit: seed.max_profiles_to_scrape ?? null,
    },
  });
  await admin.from("crawl_jobs").update({ inngest_run_id: ids[0] ?? null }).eq("id", job.id);

  revalidatePath("/seeds");
  revalidatePath("/");
  return { ok: true, crawl_job_id: job.id };
}
