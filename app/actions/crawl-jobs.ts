"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { inngest } from "@/inngest/client";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

export async function getCrawlJobProgress(job_id: string): Promise<{ scraped: number; total: number; status: string }> {
  await requireUser();
  const sb = createAdminClient();
  const { data } = await sb
    .from("crawl_jobs")
    .select("profiles_scraped, expected_profiles, status")
    .eq("id", job_id)
    .single();
  return {
    scraped: data?.profiles_scraped ?? 0,
    total: data?.expected_profiles ?? 0,
    status: data?.status ?? "unknown",
  };
}

export type ActiveJob = {
  id: string;
  type: "crawl" | "backfill";
  label: string;
  status: string;
  scraped: number;
  total: number;
  startedAt: string | null;
};

export async function getActiveJobs(): Promise<ActiveJob[]> {
  await requireUser();
  const sb = createAdminClient();

  const TEN_MIN = new Date(Date.now() - 10 * 60_000).toISOString();

  const [{ data: crawlJobs }, { count: backfillRemaining }, { count: recentUpdates }, { data: settingsRow }] = await Promise.all([
    sb.from("crawl_jobs")
      .select("id, status, profiles_scraped, expected_profiles, started_at, seeds(username)")
      .in("status", ["queued", "running"])
      .order("started_at", { ascending: false })
      .limit(5),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .is("followers", null)
      .or("backfill_error.is.null,backfill_error.eq.apify_exhausted")
      .neq("status", "rejected"),
    sb.from("leads")
      .select("*", { count: "exact", head: true })
      .not("followers", "is", null)
      .gte("updated_at", new Date(Date.now() - 90_000).toISOString()),
    sb.from("app_settings").select("backfill_started_at").eq("id", 1).single(),
  ]);

  const jobs: ActiveJob[] = [];

  for (const j of crawlJobs ?? []) {
    const seed = (j.seeds as unknown as { username: string } | null);
    const scraped = j.profiles_scraped ?? 0;
    const total = j.expected_profiles ?? 0;
    const isPlaywright = scraped === 0 && j.status === "running";
    jobs.push({
      id: j.id,
      type: "crawl",
      label: isPlaywright
        ? `Scraping @${seed?.username ?? "account"} with Playwright…`
        : `Scraping @${seed?.username ?? "account"}`,
      status: j.status,
      scraped,
      total,
      startedAt: j.started_at ?? null,
    });
  }

  const startedAt = (settingsRow as { backfill_started_at?: string | null } | null)?.backfill_started_at ?? null;
  const startingUp = !!startedAt && startedAt >= TEN_MIN && (backfillRemaining ?? 0) > 0;
  const backfillActive = ((recentUpdates ?? 0) > 0 || startingUp) && (backfillRemaining ?? 0) > 0;

  if (backfillActive) {
    jobs.push({
      id: "backfill",
      type: "backfill",
      label: startingUp && (recentUpdates ?? 0) === 0
        ? "Backfilling metadata — starting up…"
        : "Backfilling metadata",
      status: "running",
      scraped: 0,
      total: backfillRemaining ?? 0,
      startedAt: null,
    });
  }

  return jobs;
}

export async function cancelCrawl(job_id: string) {
  await requireUser();
  const sb = createAdminClient();
  const { data: job } = await sb.from("crawl_jobs").select("status").eq("id", job_id).single();
  if (!job) return { error: "job_not_found" };
  if (job.status !== "running" && job.status !== "queued") {
    return { error: `cannot cancel job in status: ${job.status}` };
  }
  const { error } = await sb
    .from("crawl_jobs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", job_id);
  if (error) return { error: error.message };
  revalidatePath("/seeds");
  revalidatePath(`/seeds/jobs/${job_id}`);
  return { ok: true };
}

export async function retryCrawl(job_id: string) {
  await requireUser();
  const admin = createAdminClient();
  const { data: prev } = await admin
    .from("crawl_jobs")
    .select("seed_id, status, max_depth")
    .eq("id", job_id)
    .single();
  if (!prev) return { error: "job_not_found" };
  if (prev.status !== "failed" && prev.status !== "cancelled") {
    return { error: `cannot retry job in status: ${prev.status}` };
  }

  const { data: seed } = await admin
    .from("seeds")
    .select("id, username, max_profiles_to_scrape")
    .eq("id", prev.seed_id)
    .single();
  if (!seed) return { error: "seed_not_found" };

  const { data: job, error: jobErr } = await admin
    .from("crawl_jobs")
    .insert({ seed_id: seed.id, status: "queued", max_depth: prev.max_depth })
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
  return { ok: true, crawl_job_id: job.id };
}
