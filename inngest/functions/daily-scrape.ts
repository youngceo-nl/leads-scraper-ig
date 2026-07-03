import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";

const SEEDS_PER_RUN = 4;

// Runs at 02:00 UTC daily. Picks the seeds least recently crawled
// and fires a crawl for each so that leads are ready before the 09:00 send.
export const dailyScrape = inngest.createFunction(
  { id: "daily-scrape", name: "Daily seed scrape" },
  { cron: "0 2 * * *" },
  async ({ step }) => {
    const settings = await step.run("load-settings", () => getSettings());
    const sb = createAdminClient();

    // All seeds that aren't capped at a tiny test size and aren't fully exhausted
    const { data: seeds } = await step.run("load-seeds", async () => {
      const { data } = await sb
        .from("seeds")
        .select("id, username, max_profiles_to_scrape, exhausted_providers")
        .or("max_profiles_to_scrape.is.null,max_profiles_to_scrape.gte.200");
      // Skip seeds where the cookie provider is exhausted (the only provider in active use)
      return { data: (data ?? []).filter((s) => !(s.exhausted_providers as string[])?.includes("cookie")) };
    });

    if (!seeds?.length) return { skipped: "no eligible seeds" };

    // Find the most recent completed crawl per seed
    const { data: recentJobs } = await step.run("load-recent-jobs", async () => {
      const { data } = await sb
        .from("crawl_jobs")
        .select("seed_id, created_at")
        .eq("status", "completed")
        .in("seed_id", seeds.map((s) => s.id))
        .order("created_at", { ascending: false });
      return { data };
    });

    // Last crawl timestamp per seed — seeds never crawled get epoch 0
    const lastCrawled: Record<string, number> = {};
    for (const s of seeds) lastCrawled[s.id] = 0;
    for (const j of recentJobs ?? []) {
      if (!lastCrawled[j.seed_id] || new Date(j.created_at).getTime() > lastCrawled[j.seed_id]) {
        lastCrawled[j.seed_id] = new Date(j.created_at).getTime();
      }
    }

    // Pick the N seeds with the oldest last crawl
    const picked = [...seeds]
      .sort((a, b) => (lastCrawled[a.id] ?? 0) - (lastCrawled[b.id] ?? 0))
      .slice(0, SEEDS_PER_RUN);

    // Insert a crawl_job row per seed and fire the event
    const started: string[] = [];
    for (const seed of picked) {
      const { data: job } = await step.run(`start-crawl-${seed.id}`, async () => {
        const { data } = await sb
          .from("crawl_jobs")
          .insert({
            seed_id: seed.id,
            seed_username: seed.username,
            status: "queued",
            max_depth: 1,
          })
          .select("id")
          .single();
        return { data };
      });

      if (!job?.id) continue;

      await step.sendEvent(`crawl-${seed.id}`, {
        name: "crawl/seed.requested",
        data: {
          crawl_job_id: job.id,
          seed_id: seed.id,
          seed_username: seed.username,
          profile_limit: seed.max_profiles_to_scrape ?? settings.max_profiles_per_account ?? 800,
        },
      });

      started.push(seed.username);
    }

    return { started };
  },
);
