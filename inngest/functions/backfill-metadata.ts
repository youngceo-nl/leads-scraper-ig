import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { scrapeProfiles } from "@/lib/apify/actors";
import { fetchProfileMetadataDirect, InstagramDirectError, sleep } from "@/lib/instagram/direct";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCrawl, logError } from "@/lib/pipeline/persist";

// Backfill basic profile metadata (followers, following, posts, bio,
// external_link, is_private, is_verified) for a batch of usernames.
//
// Two paths:
//  1. FREE — direct fetch to IG's web_profile_info endpoint using the burner
//     IG session cookie from Settings. Throttled per profile to keep the
//     account safe.
//  2. PAID — Apify profile actor in batches. Fallback when no IG cookie is
//     configured. Faster but costs Apify credits.
//
// Path is chosen at runtime by checking `settings.instagram_session_cookie`.

const APIFY_BATCH = 50;
const COOKIE_BATCH = 25;
// Base 1.0s between profiles, jittered to look human (700–1800ms range, mean
// ~1.25s). Every ~15 requests we inject a longer "thinking pause" (2–5s) to
// mimic someone scrolling and reading. Bot-detection on IG looks at
// inter-request variance + occasional natural pauses; constant intervals are
// the cheapest red flag.
const COOKIE_DELAY_BASE_MS = 1000;

function jitteredDelay(base: number): number {
  // Uniform 0.7x → 1.8x of base. Mean lifts to ~1.25x so global throughput
  // stays well under 1 req/s on average.
  const min = base * 0.7;
  const max = base * 1.8;
  return Math.floor(min + Math.random() * (max - min));
}

function maybeLongPause(): number {
  // 6% chance per request → roughly one "I'm reading a post" pause per 15-20
  // requests. 2–5s, uniform.
  if (Math.random() < 0.06) {
    return Math.floor(2000 + Math.random() * 3000);
  }
  return 0;
}


export const backfillMetadata = inngest.createFunction(
  {
    id: "backfill-metadata",
    name: "Backfill follower counts / metadata",
    retries: 2,
    concurrency: [
      { limit: 1, key: "event.data.crawl_job_id" }, // 1 backfill per crawl (cookie path = sequential anyway)
      { limit: 3 },
    ],
  },
  { event: "leads/backfill.metadata.requested" },
  async ({ event, step }) => {
    const { usernames, crawl_job_id } = event.data as {
      usernames: string[];
      crawl_job_id?: string | null;
    };
    if (!usernames || usernames.length === 0) return { processed: 0 };

    const settings = await step.run("load-settings", () => getSettings());
    const cookie = settings.instagram_session_cookie?.trim() || process.env.INSTAGRAM_SESSION_COOKIE?.trim() || null;
    const useFreePath = !!cookie;

    if (useFreePath) {
      // -------- FREE: direct fetch with IG burner cookie --------
      const batches: string[][] = [];
      for (let i = 0; i < usernames.length; i += COOKIE_BATCH) {
        batches.push(usernames.slice(i, i + COOKIE_BATCH));
      }

      let updated = 0;
      let scraped = 0;
      let halt = false;
      const allUpdatedLeadIds: string[] = [];

      for (let bi = 0; bi < batches.length; bi++) {
        if (halt) break;
        const batch = batches[bi];
        const result = await step.run(`cookie-batch-${bi}`, async () => {
          const sb = createAdminClient();
          const updatedLeadIds: string[] = [];
          let s = 0, u = 0;
          for (const username of batch) {
            try {
              const p = await fetchProfileMetadataDirect({ username, sessionCookie: cookie });
              if (!p) {
                await sleep(jitteredDelay(COOKIE_DELAY_BASE_MS) + maybeLongPause());
                continue;
              }
              s++;
              const { data, error } = await sb
                .from("leads")
                .update({
                  full_name: p.full_name,
                  bio: p.bio,
                  external_link: p.external_link,
                  followers: p.followers,
                  following: p.following,
                  posts: p.posts,
                  is_private: p.is_private,
                  is_verified: p.is_verified,
                  recent_posts: p.recent_posts,
                })
                .eq("username", p.username)
                .select("id")
                .single();
              if (!error && data?.id) {
                u++;
                // Auto-score every enriched lead — no follower gate. The hard
                // filter in score-lead still rejects out-of-range accounts.
                updatedLeadIds.push(data.id);
              }
            } catch (err) {
              const direct = err instanceof InstagramDirectError ? err : null;
              const msg = direct ? direct.message : (err as Error).message;
              await logError({
                context: "backfill.metadata.cookie",
                error_message: msg,
                payload: { username, batch_index: bi, status: direct?.status },
                crawl_job_id: crawl_job_id ?? null,
              });
              // Non-retryable IG error (cookie expired / challenge) → stop the
              // whole backfill so we don't burn the cookie or trigger more bans.
              if (direct && !direct.retryable) {
                return { s, u, updatedLeadIds, halt: true };
              }
            }
            await sleep(jitteredDelay(COOKIE_DELAY_BASE_MS) + maybeLongPause());
          }
          return { s, u, updatedLeadIds, halt: false };
        });
        scraped += result.s;
        updated += result.u;
        allUpdatedLeadIds.push(...result.updatedLeadIds);
        halt = result.halt;
      }

      // Auto-score every lead we just enriched. Each lead becomes its own
      // `lead/score.requested` event; score-lead runs them with high concurrency.
      if (allUpdatedLeadIds.length > 0) {
        await step.sendEvent(
          "fan-out-score",
          allUpdatedLeadIds.map((lead_id) => ({
            name: "lead/score.requested" as const,
            data: { lead_id, crawl_job_id: crawl_job_id ?? null },
          })),
        );
      }

      await logCrawl({
        crawl_job_id: crawl_job_id ?? null,
        profile_username: `backfill:${usernames.length}`,
        parent_username: null,
        action: "backfill_metadata",
        depth: 0,
        detail: `mode=cookie requested=${usernames.length} scraped=${scraped} updated=${updated} auto_scored=${allUpdatedLeadIds.length} batches=${batches.length}${halt ? " HALTED" : ""}`,
      });

      return { processed: usernames.length, scraped, updated, batches: batches.length, mode: "cookie", halted: halt };
    }

    // -------- PAID: Apify profile actor in batches --------
    const token = resolveApifyToken(settings);
    if (!token) {
      await logError({
        context: "backfill.metadata",
        error_message: "No IG cookie AND no Apify token — cannot backfill metadata.",
        crawl_job_id: crawl_job_id ?? null,
      });
      return { processed: 0, error: "no-cookie-no-apify-token" };
    }

    const batches: string[][] = [];
    for (let i = 0; i < usernames.length; i += APIFY_BATCH) {
      batches.push(usernames.slice(i, i + APIFY_BATCH));
    }

    let updated = 0;
    let scraped = 0;
    const apifyLeadIds: string[] = [];
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const result = await step.run(`apify-batch-${bi}`, async () => {
        try {
          return await scrapeProfiles({ token, usernames: batch });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await logError({
            context: "backfill.metadata.batch",
            error_message: msg,
            payload: { batch, batch_index: bi },
            crawl_job_id: crawl_job_id ?? null,
          });
          return [];
        }
      });
      scraped += result.length;

      const wrote = await step.run(`update-apify-batch-${bi}`, async () => {
        if (result.length === 0) return { count: 0, ids: [] as string[] };
        const sb = createAdminClient();
        let wroteCount = 0;
        const ids: string[] = [];
        for (const p of result) {
          const { data, error } = await sb
            .from("leads")
            .update({
              full_name: p.full_name,
              bio: p.bio,
              external_link: p.external_link,
              followers: p.followers,
              following: p.following,
              posts: p.posts,
              is_private: p.is_private,
              is_verified: p.is_verified,
              recent_posts: p.recent_posts,
            })
            .eq("username", p.username)
            .select("id")
            .maybeSingle();
          if (!error && data?.id) {
            wroteCount++;
            ids.push(data.id);
          }
        }
        return { count: wroteCount, ids };
      });
      updated += wrote.count;
      apifyLeadIds.push(...wrote.ids);
    }

    // Auto-score every enriched lead (no follower gate), same as the cookie path.
    if (apifyLeadIds.length > 0) {
      await step.sendEvent(
        "fan-out-score",
        apifyLeadIds.map((lead_id) => ({
          name: "lead/score.requested" as const,
          data: { lead_id, crawl_job_id: crawl_job_id ?? null },
        })),
      );
    }

    await logCrawl({
      crawl_job_id: crawl_job_id ?? null,
      profile_username: `backfill:${usernames.length}`,
      parent_username: null,
      action: "backfill_metadata",
      depth: 0,
      detail: `mode=apify requested=${usernames.length} scraped=${scraped} updated=${updated} auto_scored=${apifyLeadIds.length} batches=${batches.length}`,
    });

    return { processed: usernames.length, scraped, updated, batches: batches.length, mode: "apify" };
  },
);
