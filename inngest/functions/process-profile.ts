import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { scrapeProfileWithFallback } from "@/lib/pipeline/scrape-profile";
import { hardFilter, metricsGate } from "@/lib/pipeline/filter";
import { computeMetrics } from "@/lib/pipeline/metrics";
import { scoreProfileRouted } from "@/lib/scoring/score";
import { bumpJobCounters, getJobStatus, logCrawl, logError, persistLead } from "@/lib/pipeline/persist";

// One profile through the full pipeline:
//   scrape → hard-filter → metrics → metrics-gate → claude → persist → maybe recurse
export const processProfile = inngest.createFunction(
  {
    id: "process-profile",
    name: "Process discovered profile",
    retries: 3,
    concurrency: [
      { limit: 5, key: "event.data.crawl_job_id" }, // 5 profiles per crawl
      { limit: 20 },                                  // 20 globally (rate-limit guard)
    ],
  },
  { event: "crawl/profile.discovered" },
  async ({ event, step }) => {
    const { crawl_job_id, seed_id, username, depth, parent_username } = event.data;

    const jobStatus = await step.run("check-job-status", () => getJobStatus(crawl_job_id));
    if (jobStatus === "cancelled" || jobStatus === "failed") {
      return { skipped: jobStatus };
    }

    const settings = await step.run("load-settings", () => getSettings());
    const apifyToken = resolveApifyToken(settings);

    // 1. Scrape profile + posts (provider-aware; respects following_scraper_provider)
    let profile;
    try {
      const r = await step.run("scrape-profile", () =>
        scrapeProfileWithFallback({ username, settings, apifyToken, crawl_job_id }),
      );
      profile = r.profile;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({ context: "scrape.profile", error_message: msg, payload: { username }, crawl_job_id });
      await logCrawl({
        crawl_job_id, profile_username: username, parent_username,
        action: "scraped", depth, status: "failure", detail: msg,
      });
      throw err; // let Inngest retry
    }

    await bumpJobCounters({ crawl_job_id, scraped: 1, depth });

    // 2. Hard filter
    const hard = hardFilter(profile, settings);
    if (!hard.ok) {
      await persistLead({
        profile, metrics: null, score: null,
        status: "rejected", rejection_reason: hard.reason,
        crawl_depth: depth, source_seed_id: seed_id, parent_username,
      });
      await logCrawl({
        crawl_job_id, profile_username: username, parent_username,
        action: "filtered_hard", depth, detail: hard.reason,
      });
      await bumpJobCounters({ crawl_job_id, rejected: 1 });
      return { status: "rejected_hard", reason: hard.reason };
    }

    // 3. Metrics
    const metrics = computeMetrics(profile);

    // 4. Metrics gate
    const reelSample = profile.recent_posts.filter((p) => p.is_reel).length;
    const gate = metricsGate(metrics, settings, reelSample);
    if (!gate.ok) {
      await persistLead({
        profile, metrics, score: null,
        status: "rejected", rejection_reason: gate.reason,
        crawl_depth: depth, source_seed_id: seed_id, parent_username,
      });
      await logCrawl({
        crawl_job_id, profile_username: username, parent_username,
        action: "filtered_metrics", depth, detail: gate.reason,
      });
      await bumpJobCounters({ crawl_job_id, rejected: 1 });
      return { status: "rejected_metrics", reason: gate.reason };
    }

    // 5. AI classifies (niche / business_model / offer) → code computes scores.
    let score;
    let scoringProvider: "openai" | "claude";
    try {
      const r = await step.run("score", () =>
        scoreProfileRouted({ settings, profile, metrics }),
      );
      score = r.score;
      scoringProvider = r.provider;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({ context: "scoring", error_message: msg, payload: { username }, crawl_job_id });
      // Persist as "review" so we don't lose the profile, then rethrow for retry visibility.
      await persistLead({
        profile, metrics, score: null,
        status: "review", rejection_reason: `scoring_failed: ${msg.slice(0, 200)}`,
        crawl_depth: depth, source_seed_id: seed_id, parent_username,
      });
      throw err;
    }

    // 6. Decide status from score
    const overall = score.overall_score;
    const status: "qualified" | "review" | "rejected" =
      score.recommended_action === "qualified"
        ? "qualified"
        : score.recommended_action === "reject"
        ? "rejected"
        : "review";

    const persisted = await step.run("persist", () =>
      persistLead({
        profile, metrics, score,
        status,
        rejection_reason: status === "rejected" ? score.reason_for_score : null,
        crawl_depth: depth, source_seed_id: seed_id, parent_username,
      }),
    );

    await logCrawl({
      crawl_job_id, profile_username: username, parent_username,
      action: "scored", depth,
      detail: `provider=${scoringProvider} overall=${overall} status=${status} niche=${score.niche}`,
    });
    if (status === "qualified") await bumpJobCounters({ crawl_job_id, qualified: 1 });
    if (status === "rejected") await bumpJobCounters({ crawl_job_id, rejected: 1 });

    if (status === "qualified" && persisted?.id) {
      if (settings.enrich_funnels_auto && profile.external_link) {
        await step.sendEvent("enrich-funnel", {
          name: "lead/funnel.enrich.requested",
          data: { lead_id: persisted.id, external_link: profile.external_link, crawl_job_id },
        });
      }
      if (settings.enrich_emails_auto && profile.full_name) {
        await step.sendEvent("enrich-email", {
          name: "lead/email.enrich.requested",
          data: { lead_id: persisted.id, crawl_job_id },
        });
      }
    }

    // 7. Recurse if quality is high enough AND we have depth left
    const shouldRecurse =
      status !== "rejected" &&
      overall >= settings.crawl_score_threshold &&
      depth < settings.max_crawl_depth;

    if (shouldRecurse) {
      await step.sendEvent("recurse", {
        name: "crawl/recurse.requested",
        data: { crawl_job_id, seed_id, username, depth },
      });
      await logCrawl({
        crawl_job_id, profile_username: username, parent_username,
        action: "recurse_queued", depth, detail: `next_depth=${depth + 1}`,
      });
    }

    return { status, overall, recursed: shouldRecurse };
  },
);
