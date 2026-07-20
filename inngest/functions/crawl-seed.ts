import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { scrapeFollowingDetailedWithFallback } from "@/lib/pipeline/scrape-following";
import { bulkUpsertDiscoveredLeads, bumpFunnelCounters, logCrawl, logError } from "@/lib/pipeline/persist";
import { scrapeProfiles } from "@/lib/apify/actors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppSettings } from "@/lib/types";

const PAGE_SIZE = 50;  // accounts fetched per Instagram API call
const MAX_PAGES = 40;  // safety cap — Instagram naturally limits ~250 for other users' following
// Full-account crawls stop when the following list is exhausted rather than on
// a new-lead target, so this cap is only a runaway guard (~20k accounts).
const FULL_MAX_PAGES = 400;

export const crawlSeed = inngest.createFunction(
  {
    id: "crawl-seed",
    name: "Crawl seed account (following-only)",
    retries: 2,
    concurrency: { limit: 3, key: "event.data.seed_id" },
  },
  { event: "crawl/seed.requested" },
  async ({ event, step }) => {
    const { crawl_job_id, seed_id, seed_username, profile_limit, provider_override, full_account } = event.data;
    const fullAccount = full_account ?? false;

    await step.run("mark-running", async () => {
      const sb = createAdminClient();
      await sb
        .from("crawl_jobs")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", crawl_job_id);
    });

    const settings = await step.run("load-settings", () => getSettings(true));
    // Full-account mode has no lead target: it walks the following list to its
    // end, so only the cursor running out (or the page guard) stops it.
    const targetNew = fullAccount ? Infinity : (profile_limit ?? settings.max_profiles_per_account);
    const maxPages = fullAccount ? FULL_MAX_PAGES : MAX_PAGES;

    const effectiveSettings = provider_override
      ? { ...settings, following_scraper_provider: provider_override as AppSettings["following_scraper_provider"] }
      : settings;

    const apifyToken = resolveApifyToken(settings);

    // The seed's own follow count — the hard ceiling "found" can never exceed.
    // Fetched fresh here rather than trusted from an existing lead row: leads
    // scraped as a side-effect of someone else's crawl carry stale `following`
    // values (@pierree read 837 from an old backfill against a 650 profile).
    // Best-effort: a failure here shouldn't fail the whole crawl, it just means
    // the ceiling check below is skipped for this run.
    let followingCount: number | null = null;
    if (apifyToken) {
      followingCount = await step.run("fetch-following-count", async () => {
        try {
          const [profile] = await scrapeProfiles({ token: apifyToken, usernames: [seed_username] });
          if (!profile) return null;
          const sb = createAdminClient();
          await sb.from("seeds").update({ following_count: profile.following }).eq("id", seed_id);
          return profile.following;
        } catch (err) {
          await logError({
            context: "crawl-seed.following-count",
            error_message: err instanceof Error ? err.message : String(err),
            payload: { seed_username },
            crawl_job_id: crawl_job_id ?? null,
          });
          return null;
        }
      });
    }

    let cursor: string | null = null;
    let totalNew = 0;
    let totalScraped = 0;
    let pageIndex = 0;
    // The provider that actually ran, which under `auto` may not be the one
    // configured. Only this is safe to draw conclusions from afterwards.
    let lastProvider: string | null = null;
    const allNewUsernames: string[] = [];

    while (totalNew < targetNew && pageIndex < maxPages) {
      let r;
      try {
        r = await step.run(`scrape-page-${pageIndex}`, () =>
          scrapeFollowingDetailedWithFallback({
            username: seed_username,
            settings: effectiveSettings,
            apifyToken,
            crawl_job_id,
            // Playwright scrolls to the full target in one session; cookie API
            // pages naturally at ~50 per call with cursor continuation.
            // A full crawl asks for one page at a time — targetNew is Infinity
            // there, and the providers need a real number.
            limitOverride: fullAccount ? PAGE_SIZE : targetNew - totalNew,
            fullAccount,
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
      lastProvider = r.provider;

      const { inserted, duplicates, excluded } = await step.run(`bulk-upsert-${pageIndex}`, () =>
        bulkUpsertDiscoveredLeads(r.items, {
          crawl_depth: 1,
          source_seed_id: seed_id,
          parent_username: seed_username,
        }),
      );

      totalNew += inserted;
      // Live counter: the Activity page reads this while the run is still
      // going, so it is bumped per page rather than only in set-counters.
      // duplicates/excluded ride along so a run's full breakdown is visible in
      // its history row, not just the net new-lead count.
      if (inserted > 0 || duplicates > 0 || excluded > 0) {
        await step.run(`bump-found-${pageIndex}`, () =>
          bumpFunnelCounters({ crawl_job_id, found: inserted, duplicate: duplicates, excluded }),
        );
      }
      if (inserted > 0) {
        allNewUsernames.push(...r.items.map((i) => i.username));
      }

      // Wrapped in a step: a bare await re-runs on every Inngest replay, which
      // wrote the same line three times for a single page.
      await step.run(`log-page-${pageIndex}`, () =>
        logCrawl({
          crawl_job_id,
          profile_username: seed_username,
          parent_username: null,
          action: "scraped_following",
          depth: 0,
          detail:
            `provider=${r.provider} page=${pageIndex} total=${r.items.length} inserted_new=${inserted} duplicates=${duplicates} excluded=${excluded} cumulative_new=${totalNew}/${fullAccount ? "full" : targetNew}` +
            // A downgrade is the thing worth noticing in this log, so it goes
            // on the same line rather than only into error_logs.
            (r.fellBackFrom?.length
              ? ` FELL_BACK_FROM=${r.fellBackFrom.map((f) => f.provider).join(",")}`
              : ""),
        }),
      );

      // No cursor = end of following list — stop regardless
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
      pageIndex++;

      // Pause between Inngest steps so consecutive API pages don't fire back-to-back.
      // Each fetchFollowingDirect call resolves one page (limit=PAGE_SIZE=50), so the
      // in-function delay only fires within multi-page calls. This step.sleep covers
      // the Inngest-step-boundary gap.
      const delaySecs = Math.floor(Math.random() * 3) + 2; // 2–4 s
      await step.sleep(`inter-page-sleep-${pageIndex}`, `${delaySecs}s`);
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

    // Backfill metadata only for newly inserted leads.
    // backfill-metadata has concurrency: { limit: 1 } — one event at a time globally —
    // so we send the full list as a single event rather than splitting into parallel chunks.
    if (allNewUsernames.length > 0) {
      await step.sendEvent("backfill-metadata", {
        name: "leads/backfill.metadata.requested" as const,
        data: { usernames: allNewUsernames, crawl_job_id, event_index: 0 },
      });
    }

    // Only track cookie exhaustion — cookie is the only method with a hard cap
    // (~250 accounts). Apify handles its own pagination fully.
    // Keyed off the provider that actually ran, not the one requested: under
    // `auto` those differ, and the old code logged the request and so could
    // blame the cookie pool for an Apify run (or miss a real exhaustion).
    const isCookieRun = lastProvider === "cookie";
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
        // Only mark as exhausted if we actually fetched accounts but none were new.
        // totalScraped===0 means the API returned nothing (network/bug), not that the list is empty.
        if (totalScraped > 0 && totalNew === 0 && !cursor) {
          updated = current.includes("cookie") ? current : [...current, "cookie"];
        } else {
          updated = current.filter((p) => p !== "cookie");
        }
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          await sb.from("seeds").update({ exhausted_providers: updated }).eq("id", seed_id);
        }
      });
    }

    // Hard ceiling: a seed can never yield more accounts than it follows. A
    // breach means the logic upstream is wrong, so it's surfaced loudly rather
    // than silently capped or hidden — the leads already scraped are real and
    // stay, but the run is flagged failed so the anomaly gets investigated.
    if (followingCount != null && totalScraped > followingCount) {
      const msg = `Found ${totalScraped} accounts but @${seed_username} only follows ${followingCount} — scrape logic is producing more than the ceiling allows.`;
      await logError({
        context: "crawl-seed.ceiling-breach",
        error_message: msg,
        payload: { seed_username, totalScraped, followingCount },
        crawl_job_id: crawl_job_id ?? null,
      });
      await markJobFailed(crawl_job_id, msg);
      return { discovered: totalNew, pages: pageIndex + 1, ceilingBreach: true };
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
