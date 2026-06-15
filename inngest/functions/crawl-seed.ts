import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { scrapeFollowingDetailedWithFallback } from "@/lib/pipeline/scrape-following";
import { bulkUpsertDiscoveredLeads, logCrawl, logError } from "@/lib/pipeline/persist";
import { createAdminClient } from "@/lib/supabase/admin";

const PAGE_SIZE = 50;  // accounts fetched per Instagram API call
const MAX_PAGES = 40;  // safety cap — Instagram naturally limits ~250 for other users' following

export const crawlSeed = inngest.createFunction(
  {
    id: "crawl-seed",
    name: "Crawl seed account (following-only)",
    retries: 2,
    concurrency: { limit: 3, key: "event.data.seed_id" },
  },
  { event: "crawl/seed.requested" },
  async ({ event, step }) => {
    const { crawl_job_id, seed_id, seed_username, profile_limit, provider_override } = event.data;

    await step.run("mark-running", async () => {
      const sb = createAdminClient();
      await sb
        .from("crawl_jobs")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", crawl_job_id);
    });

    const settings = await step.run("load-settings", () => getSettings(true));
    const token = resolveApifyToken(settings);
    const targetNew = profile_limit ?? settings.max_profiles_per_account;

    const effectiveSettings = provider_override
      ? { ...settings, following_scraper_provider: provider_override }
      : settings;

    let cursor: string | null = null;
    let totalNew = 0;
    let totalScraped = 0;
    let pageIndex = 0;
    const allNewUsernames: string[] = [];

    while (totalNew < targetNew && pageIndex < MAX_PAGES) {
      let r;
      try {
        r = await step.run(`scrape-page-${pageIndex}`, () =>
          scrapeFollowingDetailedWithFallback({
            username: seed_username,
            settings: effectiveSettings,
            apifyToken: token,
            crawl_job_id,
            limitOverride: PAGE_SIZE,
            startCursor: cursor,
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logError({ context: "scrape.following.seed", error_message: msg, crawl_job_id });
        await markJobFailed(crawl_job_id, msg);
        throw err;
      }

      if (r.items.length === 0) break;
      totalScraped += r.items.length;

      const inserted = await step.run(`bulk-upsert-${pageIndex}`, () =>
        bulkUpsertDiscoveredLeads(r.items, {
          crawl_depth: 1,
          source_seed_id: seed_id,
          parent_username: seed_username,
        }),
      );

      totalNew += inserted;
      if (inserted > 0) {
        allNewUsernames.push(...r.items.map((i) => i.username));
      }

      await logCrawl({
        crawl_job_id,
        profile_username: seed_username,
        parent_username: null,
        action: "scraped_following",
        depth: 0,
        detail: `provider=${r.provider} page=${pageIndex} total=${r.items.length} inserted_new=${inserted} cumulative_new=${totalNew}/${targetNew}`,
      });

      // No cursor = end of following list — stop regardless
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
      pageIndex++;
    }

    await step.run("set-counters", async () => {
      const sb = createAdminClient();
      await sb
        .from("crawl_jobs")
        .update({
          expected_profiles: totalScraped,
          profiles_scraped: totalScraped,
          new_leads: totalNew,
        })
        .eq("id", crawl_job_id);
    });

    // Backfill metadata only for newly inserted leads
    if (allNewUsernames.length > 0) {
      await step.sendEvent("backfill-metadata", {
        name: "leads/backfill.metadata.requested" as const,
        data: { usernames: allNewUsernames, crawl_job_id },
      });
    }

    // Only track cookie exhaustion — cookie is the only method with a hard cap
    // (~250 accounts). Apify/ScrapingBee handle their own pagination fully.
    const usedProvider = provider_override ?? effectiveSettings.following_scraper_provider;
    const isCookieRun = usedProvider === "cookie" || usedProvider === "auto";
    if (isCookieRun) {
      await step.run("update-seed-exhaustion", async () => {
        const sb = createAdminClient();
        const { data: seed } = await sb
          .from("seeds")
          .select("exhausted_providers")
          .eq("id", seed_id)
          .single();
        const current: string[] = seed?.exhausted_providers ?? [];
        let updated: string[];
        if (totalNew === 0 && !cursor) {
          updated = current.includes("cookie") ? current : [...current, "cookie"];
        } else {
          updated = current.filter((p) => p !== "cookie");
        }
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          await sb.from("seeds").update({ exhausted_providers: updated }).eq("id", seed_id);
        }
      });
    }

    await markJobCompleted(crawl_job_id);
    return { discovered: totalNew, pages: pageIndex + 1 };
  },
);

async function markJobFailed(id: string, msg: string) {
  const sb = createAdminClient();
  await sb
    .from("crawl_jobs")
    .update({ status: "failed", error_message: msg.slice(0, 4000), finished_at: new Date().toISOString() })
    .eq("id", id);
}
async function markJobCompleted(id: string) {
  const sb = createAdminClient();
  await sb
    .from("crawl_jobs")
    .update({ status: "completed", finished_at: new Date().toISOString() })
    .eq("id", id);
}
