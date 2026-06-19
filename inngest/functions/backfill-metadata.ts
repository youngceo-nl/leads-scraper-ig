import { inngest } from "@/inngest/client";
import { getSettings, resolveApifyTokens } from "@/lib/config/settings";
import { scrapeProfiles } from "@/lib/apify/actors";
import { fetchProfileMetadataDirect, InstagramDirectError, sleep } from "@/lib/instagram/direct";
import { buildCookiePool, buildProxyPool, pickCookie, markRateLimited } from "@/lib/instagram/cookie-pool";
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

const APIFY_BATCH = 100;
const COOKIE_BATCH = 50;
// 300ms base with ±50% jitter → mean ~300ms, ~200 profiles/min per event.
// The web_profile_info endpoint is lightweight; no need for human-pace simulation.
const COOKIE_DELAY_BASE_MS = 300;

function jitteredDelay(base: number): number {
  const min = base * 0.5;
  const max = base * 1.5;
  return Math.floor(min + Math.random() * (max - min));
}


export const backfillMetadata = inngest.createFunction(
  {
    id: "backfill-metadata",
    name: "Backfill follower counts / metadata",
    retries: 2,
    concurrency: { limit: 3 },
  },
  { event: "leads/backfill.metadata.requested" },
  async ({ event, step }) => {
    const { usernames, crawl_job_id, event_index = 0 } = event.data as {
      usernames: string[];
      crawl_job_id?: string | null;
      event_index?: number;
    };
    if (!usernames || usernames.length === 0) return { processed: 0 };

    const settings = await step.run("load-settings", () => getSettings(true));
    const apifyTokens = resolveApifyTokens(settings);
    const cookiePool = buildCookiePool(settings);
    const entry = pickCookie(cookiePool);

    // Cookie path is preferred — free, no external quota.
    // Apify is the fallback when no IG cookie is available.
    const useFreePath = !!entry;
    const useApify = !useFreePath && apifyTokens.length > 0;

    if (!useFreePath && !useApify) {
      await logError({
        context: "backfill.metadata",
        error_message: `No cookies available (pool size: ${cookiePool.length}, all rate-limited or empty) and no Apify token configured — cannot backfill ${usernames.length} accounts.`,
        crawl_job_id: crawl_job_id ?? null,
      });
      return { processed: 0, error: "no-cookie-no-apify-token" };
    }

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
          // Check for user-requested cancellation before starting this batch.
          const fresh = await getSettings(true);
          const sb = createAdminClient();
          if (fresh.backfill_cancel_requested) {
            await sb.from("app_settings").update({ backfill_cancel_requested: false, backfill_started_at: null }).eq("id", 1);
            return { s: 0, u: 0, updatedLeadIds: [], halt: true, cancelled: true };
          }
          // Clear the "starting up" timestamp once processing actually begins.
          if (bi === 0) {
            await sb.from("app_settings").update({ backfill_started_at: null }).eq("id", 1);
          }

          // Deterministic selection using batch index — cookies and proxies rotate
          // independently so a dead proxy on one account doesn't strand its cookie.
          // We can't use module-level state (rrIndex) because Inngest replays the
          // function from scratch for each step, resetting in-process variables.
          const cookiePool = buildCookiePool(settings).filter((e) => !!e.cookie);
          if (cookiePool.length === 0) return { s: 0, u: 0, updatedLeadIds: [], halt: true };
          const proxyPool = buildProxyPool(settings);
          const slot = bi + event_index;
          const activeEntry = cookiePool[slot % cookiePool.length];
          const { cookie: activeCookie, accountUsername: activeAccount } = activeEntry;
          // Pick proxy from the shared pool; fall back to the account's own proxy if pool is empty.
          const activeProxy = proxyPool.length > 0
            ? proxyPool[slot % proxyPool.length]
            : activeEntry.proxyUrl;
          const updatedLeadIds: string[] = [];
          let s = 0, u = 0;
          let cancelledMid = false;
          for (const username of batch) {
              // Check stop flag every profile — cheap read, avoids 15s lag before honoring stop.
              const check = await sb.from("app_settings").select("backfill_cancel_requested").eq("id", 1).single();
              if (check.data?.backfill_cancel_requested) {
                await sb.from("app_settings").update({ backfill_cancel_requested: false, backfill_started_at: null }).eq("id", 1);
                cancelledMid = true;
                break;
              }
              try {
                // session: null → use Node.js fetch + undici ProxyAgent (no Playwright).
                // Playwright's APIRequestContext doesn't reliably route through the launch-time
                // proxy, causing persistent 407s. undici handles http://user:pass@host:port natively.
                const p = await fetchProfileMetadataDirect({ username, sessionCookie: activeCookie, session: null, proxyUrl: activeProxy });
                if (!p) {
                  // No data returned — account is private, deleted, or the API returned nothing.
                  // Mark it blocked so it drains out of the "remaining" queue instead of staying stuck.
                  await sb.from("leads").update({ backfill_error: "blocked" }).eq("username", username).is("followers", null);
                  await sleep(jitteredDelay(COOKIE_DELAY_BASE_MS));
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
                  updatedLeadIds.push(data.id as string);
                }
              } catch (err) {
                const direct = err instanceof InstagramDirectError ? err : null;
                const msg = direct ? direct.message : (err as Error).message;
                await logError({
                  context: "backfill.metadata.cookie",
                  error_message: `Fetching @${username} via @${activeAccount ?? "unknown"}: ${msg}`,
                  payload: { username, account: activeAccount, batch_index: bi, status: direct?.status },
                  crawl_job_id: crawl_job_id ?? null,
                });
                // Any account-level failure: break this batch so the next batch
                // tries a different account via bi % pool rotation. Never halt the
                // whole backfill — other accounts may still be healthy.
                if (direct && (!direct.retryable || direct.status === 429)) {
                  if (direct.status === 429) markRateLimited(activeCookie);
                  break;
                }
              }
              await sleep(jitteredDelay(COOKIE_DELAY_BASE_MS));
          }
          return { s, u, updatedLeadIds, halt: cancelledMid };
        });
        scraped += result.s;
        updated += result.u;
        allUpdatedLeadIds.push(...(result.updatedLeadIds as string[]));
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

    // -------- FAST: Apify profile actor in batches --------
    const token = apifyTokens[0];
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
          const isExhausted = msg.includes("403") || msg.includes("platform-feature-disabled");
          await logError({
            context: "backfill.metadata.batch",
            error_message: isExhausted ? `Apify token exhausted (403) — stopping backfill. ${msg}` : msg,
            payload: { batch, batch_index: bi, exhausted: isExhausted },
            crawl_job_id: crawl_job_id ?? null,
          });
          if (isExhausted) {
            // Mark remaining unprocessed accounts with a retriable error, not "blocked"
            const sb = createAdminClient();
            const remaining = usernames.slice(bi * APIFY_BATCH);
            await sb
              .from("leads")
              .update({ backfill_error: "apify_exhausted" })
              .in("username", remaining)
              .is("followers", null);
            throw new Error(`APIFY_EXHAUSTED: ${msg}`);
          }
          return [];
        }
      });
      scraped += result.length;

      const wrote = await step.run(`update-apify-batch-${bi}`, async () => {
        const sb = createAdminClient();
        let wroteCount = 0;
        const ids: string[] = [];

        if (result.length === 0) {
          // Entire batch blocked — mark all as blocked so they're skipped next run
          await sb
            .from("leads")
            .update({ backfill_error: "blocked" })
            .in("username", batch)
            .is("followers", null);
          return { count: 0, ids };
        }

        // Mark any usernames the actor returned no data for as blocked
        const returnedUsernames = new Set(result.map((p) => p.username));
        const missing = batch.filter((u) => !returnedUsernames.has(u));
        if (missing.length > 0) {
          await sb
            .from("leads")
            .update({ backfill_error: "blocked" })
            .in("username", missing)
            .is("followers", null);
        }

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
              backfill_error: null,
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
