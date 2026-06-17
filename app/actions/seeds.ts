"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";
import { inngest } from "@/inngest/client";
import { getSettings } from "@/lib/config/settings";
import { serperSearch } from "@/lib/serper/client";

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

// Reserved Instagram path segments that are NOT profile usernames
const IG_RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts",
  "about", "help", "legal", "privacy", "safety", "press", "direct",
  "directory", "login", "challenge", "oauth", "api",
]);
const IG_PROFILE_RE = /^https?:\/\/(www\.)?instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?(\?.*)?$/;

export type DiscoveredSeedResult = {
  username: string;
  snippet: string | null;
  title: string | null;
};

export async function discoverSeeds(opts: { keywords: string }): Promise<
  { results: DiscoveredSeedResult[] } | { error: string }
> {
  await requireUser();
  const settings = await getSettings(true);
  const apiKey = settings.serper_api_key || process.env.SERPER_API_KEY;
  if (!apiKey) return { error: "Serper API key not configured — add it in Settings." };

  const kwParts = opts.keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => `"${k}"`);
  if (kwParts.length === 0) return { error: "Enter at least one keyword." };

  // Two complementary queries: one broad, one bio-focused
  const base = `site:instagram.com ${kwParts.join(" OR ")}`;
  const [r1, r2] = await Promise.all([
    serperSearch({ apiKey, query: base, num: 20 }),
    serperSearch({ apiKey, query: `${base} bio`, num: 10 }),
  ]);

  const seen = new Set<string>();
  const results: DiscoveredSeedResult[] = [];

  for (const r of [...r1.organic, ...r2.organic]) {
    if (!r.link) continue;
    const m = r.link.match(IG_PROFILE_RE);
    if (!m) continue;
    const username = m[2].toLowerCase();
    if (IG_RESERVED.has(username)) continue;
    if (seen.has(username)) continue;
    seen.add(username);
    results.push({ username, snippet: r.snippet ?? null, title: r.title ?? null });
  }

  return { results };
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

  if (error) {
    if (!error.message.includes("duplicate")) return { error: error.message };
    // Already exists — bump created_at so it sorts to the top.
    await sb.from("seeds").update({ created_at: new Date().toISOString() }).eq("username", username);
    revalidatePath("/seeds");
    return { ok: true, already_existed: true };
  }

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

export type ScrapeProvider = "auto" | "playwright" | "cookie" | "apify" | "scrapingbee";

export async function addSeedsBulk(usernames: string[]): Promise<{ added: number; skipped: number; error?: string }> {
  await requireUser();
  const sb = createAdminClient();
  let added = 0;
  let skipped = 0;
  for (const raw of usernames) {
    const username = toUsername(raw.trim());
    if (!username) { skipped++; continue; }
    const { error } = await sb.from("seeds").insert({ username, profile_url: profileUrl(username) });
    if (error) { skipped++; continue; }
    added++;
  }
  revalidatePath("/seeds");
  return { added, skipped };
}

export async function startAllCrawls(providerOverride?: ScrapeProvider): Promise<{ started: number; error?: string }> {
  await requireUser();
  const admin = createAdminClient();
  const settings = await getSettings(true);

  const { data: seeds } = await admin.from("seeds").select("id, username, max_profiles_to_scrape");
  if (!seeds?.length) return { started: 0 };

  // Skip seeds that already have a running or queued job
  const { data: activeJobs } = await admin
    .from("crawl_jobs")
    .select("seed_id")
    .in("status", ["running", "queued"]);
  const activeSeedIds = new Set((activeJobs ?? []).map((j) => j.seed_id));

  const provider = providerOverride ?? settings.following_scraper_provider;
  let started = 0;

  for (const seed of seeds) {
    if (activeSeedIds.has(seed.id)) continue;
    const { data: job, error: jobErr } = await admin
      .from("crawl_jobs")
      .insert({ seed_id: seed.id, status: "queued", max_depth: settings.max_crawl_depth })
      .select("id")
      .single();
    if (jobErr || !job) continue;
    const { ids } = await inngest.send({
      name: "crawl/seed.requested",
      data: {
        crawl_job_id: job.id,
        seed_id: seed.id,
        seed_username: seed.username,
        profile_limit: seed.max_profiles_to_scrape ?? null,
        provider_override: providerOverride ?? null,
      },
    });
    await admin.from("crawl_jobs").update({ inngest_run_id: ids[0] ?? null }).eq("id", job.id);
    started++;
  }

  revalidatePath("/seeds");
  revalidatePath("/");
  return { started };
}

export async function startCrawl(seed_id: string, providerOverride?: ScrapeProvider) {
  await requireUser();
  const admin = createAdminClient();
  const { data: seed } = await admin
    .from("seeds")
    .select("id, username, max_profiles_to_scrape")
    .eq("id", seed_id)
    .single();
  if (!seed) return { error: "seed_not_found" };

  const settings = await getSettings(true);
  const provider = providerOverride ?? settings.following_scraper_provider;

  const apifyOk = !!(settings.apify_api_key || process.env.APIFY_TOKEN);
  const sbOk = !!(settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY);
  const cookieOk = !!(
    (settings.instagram_session_cookies ?? []).length > 0 ||
    settings.instagram_session_cookie ||
    process.env.INSTAGRAM_SESSION_COOKIE
  );

  if (provider === "apify" && !apifyOk)
    return { error: "Apify selected but no Apify API key is set." };
  if (provider === "scrapingbee" && !(sbOk && cookieOk))
    return { error: "ScrapingBee selected but missing API key or Instagram cookie." };
  if (provider === "cookie" && !cookieOk)
    return { error: "Cookie/proxy selected but no Instagram session cookie configured." };
  if (provider === "auto" && !apifyOk && !cookieOk)
    return { error: "No scrape provider configured. Add an Apify key or Instagram cookie in Settings." };

  const scoring = settings.scoring_provider;
  if (scoring === "claude" && !(settings.claude_api_key || process.env.ANTHROPIC_API_KEY))
    return { error: "Claude scoring selected but no Anthropic API key set." };
  if (scoring === "openai" && !(settings.openai_api_key || process.env.OPENAI_API_KEY))
    return { error: "OpenAI scoring selected but no OpenAI API key set." };

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
      provider_override: providerOverride ?? null,
    },
  });
  await admin.from("crawl_jobs").update({ inngest_run_id: ids[0] ?? null }).eq("id", job.id);

  revalidatePath("/seeds");
  revalidatePath("/");
  return { ok: true, crawl_job_id: job.id };
}
