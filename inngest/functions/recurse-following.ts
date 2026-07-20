import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { scrapeFollowingDetailedWithFallback } from "@/lib/pipeline/scrape-following";
import { bulkUpsertDiscoveredLeads, getJobStatus, logCrawl, logError } from "@/lib/pipeline/persist";

// Triggered when a qualified lead clears the threshold (from process-profile).
// FOLLOWING-ONLY MODE: bulk-upserts their following as `pending` leads at
// depth+1. No automatic processing — user clicks Process per row.
export const recurseFollowing = inngest.createFunction(
  {
    id: "recurse-following",
    name: "Recurse a qualified lead's following (following-only)",
    retries: 2,
    concurrency: [
      { limit: 4, key: "event.data.crawl_job_id" },
      { limit: 12 },
    ],
  },
  { event: "crawl/recurse.requested" },
  async ({ event, step }) => {
    const { crawl_job_id, seed_id, username, depth } = event.data;
    const nextDepth = depth + 1;

    const status = await step.run("check-job-status", () => getJobStatus(crawl_job_id));
    if (status === "cancelled" || status === "failed") {
      return { skipped: status };
    }

    const settings = await step.run("load-settings", () => getSettings());
    if (nextDepth > 1) return { skipped: "max_depth" };

    const token = resolveApifyToken(settings);

    let r;
    try {
      r = await step.run("scrape-following", () =>
        scrapeFollowingDetailedWithFallback({
          username,
          settings,
          apifyToken: token,
          crawl_job_id,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({ context: "scrape.following.recurse", error_message: msg, payload: { username }, crawl_job_id });
      throw err;
    }

    const { inserted, duplicates, excluded } = await step.run("bulk-upsert", () =>
      bulkUpsertDiscoveredLeads(r.items, {
        crawl_depth: nextDepth,
        source_seed_id: seed_id,
        parent_username: username,
      }),
    );

    await logCrawl({
      crawl_job_id,
      profile_username: username,
      parent_username: null,
      action: "recursed",
      depth: nextDepth,
      detail: `provider=${r.provider} total=${r.items.length} inserted_new=${inserted} duplicates=${duplicates} excluded=${excluded}`,
    });

    if (inserted > 0) {
      const freshUsernames = r.items.map((i) => i.username);
      await step.sendEvent("backfill-metadata-recurse", {
        name: "leads/backfill.metadata.requested" as const,
        data: { usernames: freshUsernames, crawl_job_id },
      });
    }

    return { discovered: inserted };
  },
);
