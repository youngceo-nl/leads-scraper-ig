import { inngest } from "@/inngest/client";
import { getSettings } from "@/lib/config/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { hardFilter, metricsGate } from "@/lib/pipeline/filter";
import { computeMetrics } from "@/lib/pipeline/metrics";
import { scoreProfileRouted } from "@/lib/scoring/score";
import { bumpFunnelCounters, logCrawl, logError } from "@/lib/pipeline/persist";
import type { ScrapedProfile } from "@/lib/types";

// Light-weight scoring: uses the data the cookie-based backfill already put
// into the leads row (bio, followers, recent_posts, etc.). No re-scraping.
// Costs: one OpenAI gpt-4o-mini call per lead. ~$0.0001 each.
export const scoreLead = inngest.createFunction(
  {
    id: "score-lead",
    name: "Score lead from cached metadata",
    retries: 2,
    concurrency: [
      { limit: 8, key: "event.data.crawl_job_id" }, // 8 concurrent scores per crawl
      { limit: 16 },                                  // 16 globally
    ],
  },
  { event: "lead/score.requested" },
  async ({ event, step }) => {
    const { lead_id, crawl_job_id } = event.data;

    const lead = await step.run("load-lead", async () => {
      const sb = createAdminClient();
      const { data, error } = await sb.from("leads").select("*").eq("id", lead_id).single();
      if (error || !data) throw new Error(error?.message ?? "lead not found");
      return data;
    });

    // Skip if already scored — unless the caller explicitly forces a rescore.
    if (lead.overall_score != null && lead.status !== "pending" && !event.data.force) {
      return { skipped: "already_scored", status: lead.status };
    }

    const profile: ScrapedProfile = {
      username: lead.username,
      full_name: lead.full_name,
      profile_url: lead.profile_url,
      bio: lead.bio,
      external_link: lead.external_link,
      followers: lead.followers ?? 0,
      following: lead.following ?? 0,
      posts: lead.posts ?? 0,
      is_private: !!lead.is_private,
      is_verified: !!lead.is_verified,
      recent_posts: lead.recent_posts ?? [],
    };

    const settings = await step.run("load-settings", () => getSettings());

    // Gate 1 — hard filter (private, follower range, bio, keywords, junk)
    const hard = hardFilter(profile, settings);
    if (!hard.ok) {
      await step.run("persist-rejected-hard", async () => {
        const sb = createAdminClient();
        await sb
          .from("leads")
          .update({
            status: "rejected",
            rejection_reason: hard.reason,
            overall_score: null,
            // .update() only touches listed columns — a lead re-processed
            // after an earlier AI pass would otherwise keep that pass's
            // reason_for_score/recommended_action, making a hard-filter
            // rejection misread as "went through AI" downstream (the funnel's
            // `verified` count, in particular, reads reason_for_score as proof
            // of that). persistLead's full-row upsert never has this problem;
            // this narrower update needs to null them explicitly instead.
            reason_for_score: null,
            recommended_action: null,
          })
          .eq("id", lead_id);
      });
      await logCrawl({
        crawl_job_id: crawl_job_id ?? null,
        profile_username: lead.username,
        parent_username: lead.parent_username,
        action: "filtered_hard",
        depth: lead.crawl_depth,
        detail: hard.reason,
      });
      return { status: "rejected", reason: hard.reason };
    }

    // Compute engagement / activity metrics from recent_posts
    const metrics = computeMetrics(profile);

    // Gate 2 — metrics gate (engagement, post frequency)
    const reelSample = profile.recent_posts.filter((p) => p.is_reel).length;
    const mg = metricsGate(metrics, settings, reelSample);
    if (!mg.ok) {
      await step.run("persist-rejected-metrics", async () => {
        const sb = createAdminClient();
        await sb
          .from("leads")
          .update({
            status: "rejected",
            rejection_reason: mg.reason,
            overall_score: null,
            // Same staleness fix as the hard-filter rejection above.
            reason_for_score: null,
            recommended_action: null,
            avg_likes: metrics.avg_likes,
            avg_comments: metrics.avg_comments,
            avg_views: metrics.avg_views,
            engagement_rate: metrics.engagement_rate,
            posts_last_30_days: metrics.posts_last_30_days,
            reels_last_30_days: metrics.reels_last_30_days,
            activity_status: metrics.activity_status,
          })
          .eq("id", lead_id);
      });
      await logCrawl({
        crawl_job_id: crawl_job_id ?? null,
        profile_username: lead.username,
        parent_username: lead.parent_username,
        action: "filtered_metrics",
        depth: lead.crawl_depth,
        detail: mg.reason,
      });
      return { status: "rejected", reason: mg.reason };
    }

    // Survived hardFilter and metricsGate — this is the "filtered" stage of the
    // funnel on the Activity page (accounts that got through, not that were cut).
    await step.run("bump-filtered", () =>
      bumpFunnelCounters({ crawl_job_id: crawl_job_id ?? null, filtered: 1 }),
    );

    // AI classification + deterministic scoring
    let scored;
    try {
      scored = await step.run("score", () =>
        scoreProfileRouted({ settings, profile, metrics }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({
        context: "score-lead.classify",
        error_message: msg,
        payload: { lead_id, username: lead.username },
        crawl_job_id: crawl_job_id ?? null,
      });
      throw err;
    }

    const score = scored.score;
    const status =
      score.recommended_action === "qualified"
        ? "qualified"
        : score.recommended_action === "review"
        ? "review"
        : "rejected";

    await step.run("persist-scored", async () => {
      const sb = createAdminClient();
      await sb
        .from("leads")
        .update({
          avg_likes: metrics.avg_likes,
          avg_comments: metrics.avg_comments,
          avg_views: metrics.avg_views,
          engagement_rate: metrics.engagement_rate,
          posts_last_30_days: metrics.posts_last_30_days,
          reels_last_30_days: metrics.reels_last_30_days,
          activity_status: metrics.activity_status,
          niche: score.niche,
          business_model: score.business_model,
          offer_type: score.offer_type,
          audience_type: score.audience_type,
          icp_fit_score: status === "rejected" ? null : score.icp_fit_score,
          traction_score: status === "rejected" ? null : score.traction_score,
          monetization_score: status === "rejected" ? null : score.monetization_score,
          activity_score: status === "rejected" ? null : score.activity_score,
          overall_score: status === "rejected" ? null : score.overall_score,
          reason_for_score: score.reason_for_score,
          recommended_action: score.recommended_action,
          // Cleared on a pass, matching process-profile.ts. Without this a lead
          // that was rejected earlier keeps its stale reason after qualifying,
          // so the funnel reads "qualified / no_recent_posts".
          rejection_reason: status === "rejected" ? score.reason_for_score : null,
          status,
        })
        .eq("id", lead_id);
    });

    await step.run("bump-verified", () =>
      bumpFunnelCounters({ crawl_job_id: crawl_job_id ?? null, verified: 1 }),
    );

    await logCrawl({
      crawl_job_id: crawl_job_id ?? null,
      profile_username: lead.username,
      parent_username: lead.parent_username,
      action: "scored",
      depth: lead.crawl_depth,
      detail: `provider=${scored.provider} overall=${score.overall_score} status=${status} niche=${score.niche}`,
    });

    return { status, overall: score.overall_score, niche: score.niche };
  },
);
