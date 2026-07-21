"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";
import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { getScrapedSeedIds, hasBeenScraped, checkRescrapeOverride } from "@/lib/seeds/scraped";
import { scrapeProfiles } from "@/lib/apify/actors";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

export async function addSeed(formData: FormData) {
  await requireUser();
  const raw = String(formData.get("input") ?? "").trim();
  if (!raw) return { error: "Empty input" };
  const username = toUsername(raw);
  if (!username) return { error: "Invalid username/URL" };

  // Optional: callers that already know this account's following count (e.g.
  // adding a recommended seed — it's already a lead, so leads.following is on
  // hand) can pass it along instead of the new seed row showing "unknown"
  // until someone hits the manual refresh. Best-known, not guaranteed fresh —
  // same caveat as any lead.following value (see crawl-seed.ts's own comment
  // on why it re-checks rather than trusting an existing lead row).
  const followingRaw = formData.get("following_count");
  const followingCount = followingRaw != null && Number.isFinite(Number(followingRaw)) && Number(followingRaw) >= 0
    ? Math.floor(Number(followingRaw))
    : null;

  const sb = createAdminClient();
  const { error } = await sb.from("seeds").insert({
    username,
    profile_url: profileUrl(username),
    ...(followingCount != null ? { following_count: followingCount } : {}),
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

export async function deleteSeed(id: string) {
  await requireUser();
  const sb = createAdminClient();
  await sb.from("seeds").delete().eq("id", id);
  revalidatePath("/seeds");
}

/**
 * Records a human judgment that this account is a bad seed candidate —
 * separate from `excluded_usernames` (that blocks re-adding a LEAD; this is
 * about seed-account quality, a different signal). Kept as a standing list
 * for training later (docs/seeds/seedpicker.md), not just a dismissal —
 * `getRecommendedSeeds` excludes anything in here going forward.
 */
export async function markBadSeed(username: string, reason?: string) {
  const authed = await createClient();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const sb = createAdminClient();
  const { error } = await sb
    .from("rejected_seeds")
    .upsert({ username, reason: reason ?? null, marked_by: user.id });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/seeds");
  return { ok: true };
}

/** Undo path from the bad-seeds table — the account becomes recommendable again. */
export async function unmarkBadSeed(username: string) {
  await requireUser();
  const sb = createAdminClient();
  const { error } = await sb.from("rejected_seeds").delete().eq("username", username);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/seeds");
  return { ok: true };
}

/**
 * A lightweight profile lookup (not a following-list scrape) so the operator
 * can see how big a full-account scrape will be *before* starting one — the
 * same Apify call crawl-seed.ts already makes internally for its ceiling
 * check, just triggerable on demand instead of only mid-crawl.
 */
export async function checkFollowingCount(id: string): Promise<{ ok: true; following_count: number } | { ok: false; error: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { data: seed } = await sb.from("seeds").select("id, username").eq("id", id).single();
  if (!seed) return { ok: false, error: "seed_not_found" };

  const settings = await getSettings(true);
  const apifyToken = resolveApifyToken(settings);
  if (!apifyToken) return { ok: false, error: "No Apify token configured — add one in Settings." };

  const [profile] = await scrapeProfiles({ token: apifyToken, usernames: [seed.username] });
  if (!profile) return { ok: false, error: `Apify returned nothing for @${seed.username}.` };

  await sb.from("seeds").update({ following_count: profile.following }).eq("id", id);
  revalidatePath("/seeds");
  return { ok: true, following_count: profile.following };
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

  const { data: seeds } = await admin.from("seeds").select("id, username");
  if (!seeds?.length) return { started: 0 };

  // Skip seeds that already have a running or queued job
  const { data: activeJobs } = await admin
    .from("crawl_jobs")
    .select("seed_id")
    .in("status", ["running", "queued"]);
  const activeSeedIds = new Set((activeJobs ?? []).map((j) => j.seed_id));

  // "Crawl all" never re-scrapes: overriding is a deliberate per-account
  // decision, not something to apply in bulk.
  const scrapedSeedIds = await getScrapedSeedIds(seeds.map((s) => s.id));

  const provider = providerOverride ?? settings.following_scraper_provider;
  let started = 0;

  for (const seed of seeds) {
    if (activeSeedIds.has(seed.id) || scrapedSeedIds.has(seed.id)) continue;
    const { data: job, error: jobErr } = await admin
      .from("crawl_jobs")
      .insert({ seed_id: seed.id, status: "queued", max_depth: 1 })
      .select("id")
      .single();
    if (jobErr || !job) continue;
    const { ids } = await inngest.send({
      name: "crawl/seed.requested",
      data: {
        crawl_job_id: job.id,
        seed_id: seed.id,
        seed_username: seed.username,
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

export async function startCrawl(
  seed_id: string,
  providerOverride?: ScrapeProvider,
  overridePassword?: string,
) {
  await requireUser();
  const admin = createAdminClient();
  const { data: seed } = await admin
    .from("seeds")
    .select("id, username")
    .eq("id", seed_id)
    .single();
  if (!seed) return { error: "seed_not_found" };

  // An account is scraped once; re-running costs credits and re-walks a list
  // already processed, so it takes the override password.
  if (await hasBeenScraped(seed_id)) {
    const denied = checkRescrapeOverride(overridePassword);
    if (denied) {
      // Revalidate so the row re-renders as scraped: the page may have been
      // loaded before this seed's crawl finished, in which case it is still
      // showing "Start search" and no password field.
      revalidatePath("/seeds");
      // Lets the client reveal the password input rather than telling the user
      // to enter a password into a field that isn't on screen.
      return { error: denied, needs_override: true };
    }
  }

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
  if (scoring === "gemini" && !(settings.gemini_api_key || process.env.GEMINI_API_KEY))
    return { error: "Gemini scoring selected but no Gemini API key set." };
  if (scoring === "groq" && !(settings.groq_api_key || process.env.GROQ_API_KEY))
    return { error: "Groq scoring selected but no Groq API key set." };

  const { data: job, error: jobErr } = await admin
    .from("crawl_jobs")
    .insert({ seed_id: seed.id, status: "queued", max_depth: 1 })
    .select("id")
    .single();
  if (jobErr || !job) return { error: jobErr?.message ?? "job_create_failed" };

  const { ids } = await inngest.send({
    name: "crawl/seed.requested",
    data: {
      crawl_job_id: job.id,
      seed_id: seed.id,
      seed_username: seed.username,
      provider_override: providerOverride ?? null,
    },
  });
  await admin.from("crawl_jobs").update({ inngest_run_id: ids[0] ?? null }).eq("id", job.id);

  revalidatePath("/seeds");
  revalidatePath("/");
  return {
    ok: true,
    crawl_job_id: job.id,
    seed_username: seed.username,
  };
}

