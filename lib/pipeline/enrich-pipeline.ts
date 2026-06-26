import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { findYouTubeChannel } from "@/lib/youtube/find";
import { inferRealName } from "@/lib/youtube/infer-name";
import { findYouTubeChannelFromPage } from "@/lib/youtube/from-page";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";
import { attemptYoutubeEmail } from "@/lib/youtube/email-from-channel";
import { refreshAndSaveYoutubeCookie, youtubeLoginConfigured, checkYoutubeCookieLive } from "@/lib/youtube/refresh-cookie";
import { persistRefreshedYtCookie } from "@/lib/youtube/cookie-jar";
import { extractEmailFromText } from "@/lib/leads/email-extract";
import { inferEmailFromDomain, extractDomain } from "@/lib/email/domain-inference";
import { findEmailWithHunter } from "@/lib/email/hunter";
import { findEmailWithFindymail, findEmailWithFindymailLinkedin } from "@/lib/email/findymail";
import { findEmailWithProspeo, findEmailWithProspeoLinkedin } from "@/lib/email/prospeo";
import { pickKey, markRateLimited, markQuotaExhausted, isQuotaReason, isInvalidKeyReason } from "@/lib/email/key-pool";
import { persistKeyExhausted, persistYtCookieStatus, persistIgCookieStatus } from "@/app/actions/settings";
import { scrapeEmailFromWebsite } from "@/lib/email/website-scrape";
import { findEmailWithApollo } from "@/lib/email/apollo";
import { verifyEmail, verifyStatusToEmailStatus } from "@/lib/email/verify";
import { findLinkedInUrl } from "@/lib/linkedin/find";
import { extractLinkedInProfileUrl } from "@/lib/linkedin/profile-url";
import type { EnrichProgress } from "@/lib/pipeline/enrich-progress";

export type EnrichPipelineResult = {
  ok: boolean;
  linkedin_url: string | null;
  youtube_url: string | null;
  email: string | null;
  email_status: string;
  source: "cached" | "ig_bio" | "website" | "youtube" | "linkedin" | "domain_inference" | "hunter" | "apollo" | "findymail" | "prospeo" | "skipped";
  // User-facing summary of what happened when no email was found.
  error: string | null;
  // Full step-by-step trace, surfaced behind a "details" affordance in the UI.
  detail?: string | null;
};

export async function enrichLeadPipeline(opts: {
  leadId: string;
  force?: boolean;
  // Optional live-progress sink. The streaming route passes this to surface each
  // source as it's checked; the Inngest worker omits it (no UI to update).
  onStep?: (ev: EnrichProgress) => void;
}): Promise<EnrichPipelineResult> {
  const emit = (ev: EnrichProgress) => {
    try { opts.onStep?.(ev); } catch { /* progress is best-effort, never fatal */ }
  };
  const sb = createAdminClient();
  const { data: lead } = await sb
    .from("leads")
    .select("id, username, full_name, external_link, funnel_url, email, email_status, linkedin_url, youtube_url, niche, bio")
    .eq("id", opts.leadId)
    .single();
  if (!lead) {
    return { ok: false, linkedin_url: null, youtube_url: null, email: null, email_status: "error", source: "skipped", error: "We couldn't find this lead anymore — try refreshing the page.", detail: "lead_not_found" };
  }

  const existingLinkedin = (lead.linkedin_url as string | null) ?? null;
  const existingYoutube = (lead.youtube_url as string | null) ?? null;

  // Cost-skip: already has a confirmed email, do nothing unless force=true.
  if (!opts.force && lead.email && lead.email_status && /^(valid|found)$/i.test(lead.email_status as string)) {
    return {
      ok: true,
      linkedin_url: existingLinkedin,
      youtube_url: existingYoutube,
      email: lead.email as string,
      email_status: lead.email_status as string,
      source: "cached",
      error: null,
    };
  }

  // Accumulates a one-line trace of every step so the error shown in the UI
  // tells the user exactly what ran and why each step came up empty.
  const steps: string[] = [];

  const settings = await getSettings();
  const serperKey = settings.serper_api_key || process.env.SERPER_API_KEY || "";
  const capsolverKey = settings.capsolver_api_key || process.env.CAPSOLVER_API_KEY || "";
  const openAiKey = settings.openai_api_key || process.env.OPENAI_API_KEY || "";
  const zerobounceKeys = [
    ...(settings.zerobounce_api_keys ?? []),
    ...(settings.zerobounce_api_key ? [settings.zerobounce_api_key] : []),
    ...(process.env.ZEROBOUNCE_API_KEY ? [process.env.ZEROBOUNCE_API_KEY] : []),
  ].filter(Boolean);
  // Pick a random key from the pool to spread load across accounts.
  const zerobounceKey = zerobounceKeys.length > 0
    ? zerobounceKeys[Math.floor(Math.random() * zerobounceKeys.length)]
    : null;
  const neverbounceKey = settings.neverbounce_api_key || process.env.NEVERBOUNCE_API_KEY || null;

  // ── Step 1: email already published in the Instagram bio (free). ──────────
  emit({ stage: "bio", state: "start", label: "Instagram bio…" });
  const bioEmail = extractEmailFromText(lead.bio as string | null);
  if (bioEmail) {
    emit({ stage: "bio", state: "hit", label: "Found in bio" });
    return persistAndReturn({
      leadId: opts.leadId,
      patch: {
        email: bioEmail,
        email_status: "found",
        email_provider: "instagram_bio",
        email_verifier: null,
        enriched_at: new Date().toISOString(),
        enrichment_error: null,
      },
      result: { ok: true, linkedin_url: existingLinkedin, youtube_url: existingYoutube, email: bioEmail, email_status: "found", source: "ig_bio", error: null },
      verify: { email: bioEmail, zerobounceKey, neverbounceKey },
    });
  }
  steps.push("bio: none");

  // Build YT cookie pool: managed accounts first (most likely fresh), then manual cookies.
  const ytCookiePool: string[] = [];
  for (const a of settings.yt_accounts ?? []) {
    const c = a.cookie?.trim();
    if (c && !ytCookiePool.includes(c)) ytCookiePool.push(c);
  }
  for (const c of settings.yt_google_cookies ?? []) { if (c.trim() && !ytCookiePool.includes(c.trim())) ytCookiePool.push(c.trim()); }
  const legacySingle = (settings.yt_google_cookie || process.env.YT_GOOGLE_COOKIE || "").trim();
  if (legacySingle && !ytCookiePool.includes(legacySingle)) ytCookiePool.push(legacySingle);

  let ytGoogleCookie = ytCookiePool[0] ?? "";

  const username = (lead.username as string | null) ?? null;
  let externalLink = (lead.external_link as string | null) ?? null;
  const funnelUrl = (lead.funnel_url as string | null) ?? null;
  const fullName = (lead.full_name as string | null) ?? null;
  const tokens = fullName?.trim().split(/\s+/).filter(Boolean) ?? [];

  // Self-heal a missing bio link: many leads never had their IG metadata
  // backfilled, so external_link is null and there's nothing to follow. If an IG
  // session cookie is configured, re-fetch just the profile fields (no reels) to
  // recover the link — that's what holds the Linktree / YouTube button.
  if (!externalLink && username) {
    const igCookie =
      settings.instagram_session_cookie?.trim() ||
      settings.instagram_session_cookies?.[0]?.trim() ||
      process.env.INSTAGRAM_SESSION_COOKIE?.trim() ||
      null;
    try {
      const { fetchProfileMetadataDirect, sleep: igSleep, InstagramDirectError } = await import("@/lib/instagram/direct");
      // Small human-pace delay before hitting IG API — this runs inside the email
      // enrichment flow which may fire many times in parallel, so we throttle here.
      await igSleep(Math.floor(2_000 + Math.random() * 3_000));
      let meta;
      try {
        meta = await fetchProfileMetadataDirect({ username, sessionCookie: igCookie, skipReels: true });
      } catch (innerErr) {
        if (innerErr instanceof InstagramDirectError && (innerErr.status === 401 || innerErr.status === 403)) {
          void persistIgCookieStatus("dead");
        }
        throw innerErr;
      }
      if (meta?.external_link) {
        void persistIgCookieStatus("live");
        externalLink = meta.external_link;
        steps.push("ig_refetch: recovered bio link");
        await sb.from("leads").update({ external_link: meta.external_link, bio: meta.bio ?? lead.bio }).eq("id", opts.leadId);
      } else {
        steps.push("ig_refetch: no bio link");
      }
    } catch (err) {
      steps.push(`ig_refetch: ${(err as Error).message.slice(0, 60)}`);
    }
  }

  // ── Step 1b: email on the bio link page (free). ─────────────────────────────
  // Static page fetch — cheaper than YouTube channel discovery, so we do it first.
  // externalLink may have been recovered by the ig_refetch block above.
  if (externalLink) {
    emit({ stage: "website", state: "start", label: "Bio link page…" });
    const ws = await scrapeEmailFromWebsite(externalLink);
    if ("email" in ws) {
      emit({ stage: "website", state: "hit", label: "Found on website" });
      return persistAndReturn({
        leadId: opts.leadId,
        patch: {
          email: ws.email,
          email_status: "found",
          email_provider: "website_scrape",
          email_verifier: null,
          enriched_at: new Date().toISOString(),
          enrichment_error: null,
        },
        result: { ok: true, linkedin_url: existingLinkedin, youtube_url: existingYoutube, email: ws.email, email_status: "found", source: "website", error: null },
        verify: { email: ws.email, zerobounceKey, neverbounceKey },
      });
    }
    steps.push(`website_scrape: ${ws.reason}`);
    emit({ stage: "website", state: "miss", label: "Bio link — no email" });
  } else {
    steps.push("website_scrape: skipped (no external link)");
  }

  // ── Step 2: resolve the YouTube channel, then scrape its About page. ──────
  let youtubeUrl: string | null = existingYoutube;
  let youtubeError: string | null = null;
  let ytAuthFailed = false;
  let ytGatedError: string | null = null;

  emit({ stage: "youtube", state: "start", label: "YouTube channel…" });
  if (!youtubeUrl) {
    youtubeUrl = extractYouTubeChannelUrl(externalLink);
    if (youtubeUrl) steps.push("yt_url: from bio link");
  }
  if (!youtubeUrl) {
    for (const link of [externalLink, funnelUrl]) {
      if (!link || extractYouTubeChannelUrl(link) || link.includes("linkedin.com")) continue;
      const fromPage = await findYouTubeChannelFromPage(link);
      steps.push(`yt_from_page(${link.slice(0, 40)}): ${fromPage.url ? fromPage.url.slice(0, 40) : fromPage.error}`);
      if (fromPage.url) { youtubeUrl = fromPage.url; break; }
    }
  }
  if (!youtubeUrl && serperKey && (tokens.length >= 2 || username)) {
    let searchName = fullName;
    if (tokens.length < 2 && openAiKey) {
      const inferred = await inferRealName({
        apiKey: openAiKey,
        username,
        fullName,
        bio: lead.bio as string | null,
      });
      if (inferred) {
        searchName = inferred;
        steps.push(`yt_infer_name: "${inferred}"`);
      } else {
        steps.push("yt_infer_name: unknown");
      }
    }
    const hint = buildHint(lead.niche as string | null, lead.bio as string | null);
    const lookup = await findYouTubeChannel({ apiKey: serperKey, fullName: searchName, username, hints: hint });
    youtubeUrl = lookup.url;
    youtubeError = lookup.error;
    steps.push(`yt_serper: ${youtubeUrl ? youtubeUrl.slice(0, 50) : (lookup.error ?? "not found")}`);
  } else if (!youtubeUrl && !serperKey) {
    steps.push("yt_serper: skipped (no Serper key)");
  }

  if (youtubeUrl) {
    emit({ stage: "youtube", state: "start", label: "YouTube About…" });
    const ytProxy = process.env.YT_REVEAL_PROXY || null;
    let mintedThisRun = false;
    if (youtubeLoginConfigured(settings)) {
      const liveness = ytGoogleCookie ? await checkYoutubeCookieLive(ytGoogleCookie) : "dead";
      steps.push(`yt_cookie_check: ${ytGoogleCookie ? liveness : "absent"}`);
      if (liveness === "dead") {
        const minted = await refreshAndSaveYoutubeCookie();
        if (minted.cookie) {
          ytGoogleCookie = minted.cookie;
          mintedThisRun = true;
          steps.push("yt_cookie_refresh: minted");
        } else {
          steps.push(`yt_cookie_refresh: ${minted.error}`);
        }
      }
    }

    let attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytGoogleCookie, capsolverKey, proxy: ytProxy });
    if (attempt.updatedCookie) void persistRefreshedYtCookie(ytGoogleCookie, attempt.updatedCookie);
    if (attempt.authFailed && youtubeLoginConfigured(settings) && !mintedThisRun) {
      const refreshed = await refreshAndSaveYoutubeCookie();
      if (refreshed.cookie) {
        ytGoogleCookie = refreshed.cookie;
        steps.push("yt_cookie_refresh: ok");
        attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytGoogleCookie, capsolverKey, proxy: ytProxy });
        if (attempt.updatedCookie) void persistRefreshedYtCookie(ytGoogleCookie, attempt.updatedCookie);
      } else {
        steps.push(`yt_cookie_refresh: ${refreshed.error}`);
      }
    }

    steps.push(...attempt.trace);
    if (attempt.email && attempt.provider) {
      void persistYtCookieStatus("live");
      emit({ stage: "youtube", state: "hit", label: "Found on YouTube" });
      return persistAndReturn({
        leadId: opts.leadId,
        patch: {
          youtube_url: youtubeUrl,
          youtube_lookup_error: null,
          email: attempt.email,
          email_status: "found",
          email_provider: attempt.provider,
          email_verifier: null,
          enriched_at: new Date().toISOString(),
          enrichment_error: null,
        },
        result: { ok: true, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: attempt.email, email_status: "found", source: "youtube", error: null },
        verify: { email: attempt.email, zerobounceKey, neverbounceKey },
      });
    }
    youtubeError = youtubeError ?? attempt.youtubeError;
    ytAuthFailed = attempt.authFailed;
    const capLine = attempt.trace.find((t) => t.startsWith("yt_capsolver: "));
    if (capLine) {
      const v = capLine.slice("yt_capsolver: ".length);
      if (v !== "found" && v !== "none" && !v.startsWith("skipped")) ytGatedError = v;
    }
  } else {
    steps.push("yt_cookie_scrape: skipped (no channel found)");
  }

  // ── Step 3: LinkedIn — find profile URL, then ask Prospeo/Findymail for the email ──
  // LinkedIn email finders are more accurate than domain+name guessing because they
  // look up the person directly, not pattern-match against a domain.
  let linkedinUrl: string | null = existingLinkedin;
  {
    const findymailKeys = [
      ...(settings.findymail_api_keys ?? []),
      ...(process.env.FINDYMAIL_API_KEY ? [process.env.FINDYMAIL_API_KEY] : []),
    ].filter(Boolean);
    const prospeoKeys = [
      ...(settings.prospeo_api_keys ?? []),
      ...(process.env.PROSPEO_API_KEY ? [process.env.PROSPEO_API_KEY] : []),
    ].filter(Boolean);
    const hasLinkedInFinder = findymailKeys.length > 0 || prospeoKeys.length > 0;

    if (hasLinkedInFinder) {
      emit({ stage: "linkedin", state: "start", label: "LinkedIn…" });

      // 3a. Resolve LinkedIn URL if we don't already have it
      if (!linkedinUrl) {
        // Check bio and external link first (free)
        for (const src of [lead.bio as string | null, externalLink]) {
          const extracted = extractLinkedInProfileUrl(src);
          if (extracted) { linkedinUrl = extracted; steps.push("li_url: from_bio_or_link"); break; }
        }
      }
      if (!linkedinUrl && serperKey) {
        const lookup = await findLinkedInUrl({
          apiKey: serperKey,
          fullName: fullName,
          username: username,
          hints: (lead.niche as string | null) ?? (lead.bio as string | null)?.slice(0, 60) ?? null,
        });
        linkedinUrl = lookup.url;
        steps.push(`li_serper: ${linkedinUrl ?? (lookup.error ?? "not_found")}`);
      } else if (!linkedinUrl && !serperKey) {
        steps.push("li_serper: skipped (no Serper key)");
      }

      // Save LinkedIn URL to DB now even if email lookup fails — it's useful on its own
      if (linkedinUrl && linkedinUrl !== existingLinkedin) {
        await sb.from("leads").update({ linkedin_url: linkedinUrl }).eq("id", opts.leadId);
      }

      // 3b. LinkedIn email lookup — Prospeo first (more reliable), then Findymail
      if (linkedinUrl) {
        if (prospeoKeys.length > 0) {
          const key = pickKey("prospeo", prospeoKeys);
          if (key) {
            const r = await findEmailWithProspeoLinkedin({ apiKey: key, linkedinUrl });
            if (r.email) {
              emit({ stage: "linkedin", state: "hit", label: "Found via LinkedIn (Prospeo)" });
              return persistAndReturn({
                leadId: opts.leadId,
                patch: { linkedin_url: linkedinUrl, email: r.email, email_status: "found", email_provider: "prospeo_linkedin", email_verifier: null, enriched_at: new Date().toISOString(), enrichment_error: null },
                result: { ok: true, linkedin_url: linkedinUrl, youtube_url: youtubeUrl, email: r.email, email_status: "found", source: "linkedin", error: null },
                verify: { email: r.email, zerobounceKey, neverbounceKey },
              });
            }
            const reason = "reason" in r ? r.reason : "no_email";
            if (reason === "rate_limited") markRateLimited("prospeo", key);
            else if (isQuotaReason(reason) || isInvalidKeyReason(reason)) { markQuotaExhausted("prospeo", key); void persistKeyExhausted("prospeo", key); }
            steps.push(`li_prospeo: ${reason}`);
          } else {
            steps.push("li_prospeo: skipped (all keys exhausted)");
          }
        }

        if (findymailKeys.length > 0) {
          const key = pickKey("findymail", findymailKeys);
          if (key) {
            const r = await findEmailWithFindymailLinkedin({ apiKey: key, linkedinUrl });
            if (r.email) {
              emit({ stage: "linkedin", state: "hit", label: "Found via LinkedIn (Findymail)" });
              return persistAndReturn({
                leadId: opts.leadId,
                patch: { linkedin_url: linkedinUrl, email: r.email, email_status: "found", email_provider: "findymail_linkedin", email_verifier: null, enriched_at: new Date().toISOString(), enrichment_error: null },
                result: { ok: true, linkedin_url: linkedinUrl, youtube_url: youtubeUrl, email: r.email, email_status: "found", source: "linkedin", error: null },
                verify: { email: r.email, zerobounceKey, neverbounceKey },
              });
            }
            const reason = "reason" in r ? r.reason : "no_email";
            if (reason === "rate_limited") markRateLimited("findymail", key);
            else if (isQuotaReason(reason) || isInvalidKeyReason(reason)) { markQuotaExhausted("findymail", key); void persistKeyExhausted("findymail", key); }
            steps.push(`li_findymail: ${reason}`);
          } else {
            steps.push("li_findymail: skipped (all keys exhausted)");
          }
        }
        emit({ stage: "linkedin", state: "miss", label: "LinkedIn — no email" });
      } else {
        emit({ stage: "linkedin", state: "miss", label: "LinkedIn not found" });
        steps.push("li_email: skipped (no profile url)");
      }
    } else {
      steps.push("linkedin: skipped (no findymail/prospeo keys)");
    }
  }

  // ── Step 4: email finder waterfall — Hunter → Findymail → Prospeo → domain inference ──
  // Each paid provider runs only when its key is configured. Domain inference
  // (free DNS pattern guess) is always the last resort.
  {
    const hunterKey = settings.hunter_api_key || process.env.HUNTER_API_KEY || "";
    const apolloKey = settings.apollo_api_key || process.env.APOLLO_API_KEY || "";
    const findymailKeys = [
      ...(settings.findymail_api_keys ?? []),
      ...(process.env.FINDYMAIL_API_KEY ? [process.env.FINDYMAIL_API_KEY] : []),
    ].filter(Boolean);
    const prospeoKeys = [
      ...(settings.prospeo_api_keys ?? []),
      ...(process.env.PROSPEO_API_KEY ? [process.env.PROSPEO_API_KEY] : []),
    ].filter(Boolean);
    const domain = extractDomain(externalLink ?? funnelUrl);

    if (domain) {
      emit({ stage: "domain_inference", state: "start", label: "Email finder…" });

      let inferredEmail: string | null = null;
      let inferSource: "hunter" | "apollo" | "findymail" | "prospeo" | "domain_inference" = "domain_inference";

      // 3a. Hunter.io (single key — paid, not rotated)
      if (!inferredEmail && hunterKey) {
        const r = await findEmailWithHunter({ apiKey: hunterKey, domain, fullName });
        if (r.email) {
          inferredEmail = r.email;
          inferSource = "hunter";
          steps.push(`hunter: ${r.email} (score=${"score" in r ? r.score : "?"})`);
        } else {
          steps.push(`hunter: ${"reason" in r ? r.reason : "no_email"}`);
        }
      } else if (!hunterKey) {
        steps.push("hunter: skipped (no key)");
      }

      // 3b. Apollo.io (single key — free tier 600 credits/month)
      if (!inferredEmail && apolloKey) {
        const r = await findEmailWithApollo({ apiKey: apolloKey, domain, fullName });
        if ("email" in r) {
          inferredEmail = r.email;
          inferSource = "apollo";
          steps.push(`apollo: ${r.email}`);
        } else {
          steps.push(`apollo: ${r.reason}`);
        }
      } else if (!apolloKey) {
        steps.push("apollo: skipped (no key)");
      }

      // 3d. Findymail — rotate through free-tier account pool
      if (!inferredEmail && findymailKeys.length > 0) {
        const key = pickKey("findymail", findymailKeys);
        if (key) {
          const r = await findEmailWithFindymail({ apiKey: key, domain, fullName });
          if (r.email) {
            inferredEmail = r.email;
            inferSource = "findymail";
            steps.push(`findymail: ${r.email}`);
          } else {
            const reason = "reason" in r ? r.reason : "no_email";
            if (reason === "rate_limited") markRateLimited("findymail", key);
            else if (isQuotaReason(reason) || isInvalidKeyReason(reason)) { markQuotaExhausted("findymail", key); void persistKeyExhausted("findymail", key); }
            steps.push(`findymail: ${reason}`);
          }
        } else {
          steps.push("findymail: skipped (all keys exhausted)");
        }
      } else if (!findymailKeys.length) {
        steps.push("findymail: skipped (no keys)");
      }

      // 3e. Prospeo — rotate through free-tier account pool
      if (!inferredEmail && prospeoKeys.length > 0) {
        const key = pickKey("prospeo", prospeoKeys);
        if (key) {
          const r = await findEmailWithProspeo({ apiKey: key, domain, fullName });
          if (r.email) {
            inferredEmail = r.email;
            inferSource = "prospeo";
            steps.push(`prospeo: ${r.email}`);
          } else {
            const reason = "reason" in r ? r.reason : "no_email";
            if (reason === "rate_limited") markRateLimited("prospeo", key);
            else if (isQuotaReason(reason) || isInvalidKeyReason(reason)) { markQuotaExhausted("prospeo", key); void persistKeyExhausted("prospeo", key); }
            steps.push(`prospeo: ${reason}`);
          }
        } else {
          steps.push("prospeo: skipped (all keys exhausted)");
        }
      } else if (!prospeoKeys.length) {
        steps.push("prospeo: skipped (no keys)");
      }

      // 3f. Free DNS pattern guess — always last
      if (!inferredEmail) {
        const r = await inferEmailFromDomain({ externalLink: externalLink ?? funnelUrl, fullName });
        if (r.email) {
          inferredEmail = r.email;
          steps.push(`domain_inference: ${r.email} (${"pattern" in r ? r.pattern : ""})`);
        } else {
          steps.push(`domain_inference: ${"reason" in r ? r.reason : "no_email"}`);
        }
      }

      if (inferredEmail) {
        const providerLabel: Record<typeof inferSource, string> = {
          hunter: "Found via Hunter",
          apollo: "Found via Apollo",
          findymail: "Found via Findymail",
          prospeo: "Found via Prospeo",
          domain_inference: "Inferred from domain",
        };
        emit({ stage: "domain_inference", state: "hit", label: providerLabel[inferSource] });
        return persistAndReturn({
          leadId: opts.leadId,
          patch: {
            email: inferredEmail,
            email_status: "inferred",
            email_provider: inferSource,
            email_verifier: null,
            enriched_at: new Date().toISOString(),
            enrichment_error: null,
          },
          result: {
            ok: true,
            linkedin_url: linkedinUrl,
            youtube_url: youtubeUrl,
            email: inferredEmail,
            email_status: "inferred",
            source: inferSource,
            error: null,
          },
          verify: { email: inferredEmail, zerobounceKey, neverbounceKey },
        });
      }
    } else {
      steps.push("domain_inference: skipped (no personal domain)");
    }
  }


  // ── Nothing turned up through any of the available (free) public sources. ──
  // Build a clear, human-readable explanation of what we tried — and,
  // when a lookup was skipped because an integration isn't set up, say exactly
  // what to configure so the user can act on it.
  const checked: string[] = ["the Instagram bio"];
  if (steps.some((s) => s.startsWith("website_scrape:") && !s.includes("skipped"))) checked.push("their website");
  if (youtubeUrl) checked.push("their YouTube About page");
  if (steps.some((s) => s.startsWith("hunter:") && !s.includes("skipped"))) checked.push("Hunter.io");
  if (steps.some((s) => s.startsWith("apollo:") && !s.includes("skipped"))) checked.push("Apollo.io");
  if (steps.some((s) => s.startsWith("findymail:") && !s.includes("skipped"))) checked.push("Findymail");
  if (steps.some((s) => s.startsWith("prospeo:") && !s.includes("skipped"))) checked.push("Prospeo");
  if (steps.some((s) => s.startsWith("domain_inference:") && !s.includes("skipped"))) checked.push("domain pattern lookup");

  // Surface the most actionable problem first. A blocked/misconfigured lookup
  // is far more useful to the user than a generic "nothing found".
  const problems: string[] = [];

  // 1) YouTube session cookie is invalid / expired / logged out — the single
  //    most common reason the gated reveal can't run.
  const cookieBroken =
    ytAuthFailed || (!!ytGatedError && /invalid cookie|addcookies|setcookies|not signed in|logged out/i.test(ytGatedError));
  if (cookieBroken) void persistYtCookieStatus("dead");
  if (youtubeUrl && cookieBroken) {
    problems.push(
      "Your YouTube session cookie looks invalid or expired, so we couldn't open the gated “View email” page. Paste a fresh Cookie header from a logged-in YouTube session in Settings.",
    );
  } else if (youtubeUrl && ytGatedError) {
    // 2) The reveal failed for some other reason (captcha, network, …).
    problems.push(`The YouTube “View email” reveal failed: ${shorten(ytGatedError)}.`);
  } else if (youtubeUrl && ytGoogleCookie && !capsolverKey) {
    // 3) Channel found and cookie present, but no key to solve the captcha that
    //    guards the email — tell the user how to enable it.
    problems.push(
      "This channel hides its email behind YouTube’s “View email” button. Add a CapSolver API key in Settings to reveal it automatically.",
    );
  }

  // 4) No YouTube channel could be found because Google search is off.
  if (!youtubeUrl && !serperKey) {
    problems.push("To search Google for their YouTube channel, add a Serper.dev API key in Settings.");
  }
  // 5) Channel found but no cookie at all to read the About page.
  else if (youtubeUrl && !ytGoogleCookie && !youtubeLoginConfigured(settings)) {
    problems.push("To read emails from YouTube About pages, add a YouTube session cookie in Settings.");
  }

  const trace = steps.join(" · ");
  const message =
    problems.length > 0
      ? `No email found yet. ${problems.join(" ")}`
      : `No public email found. We checked ${formatList(checked)}, but none of them publish one.`;

  return persistAndReturn({
    leadId: opts.leadId,
    patch: {
      youtube_url: youtubeUrl,
      youtube_lookup_error: youtubeError,
      email: null,
      email_status: "not_found",
      email_provider: null,
      email_verifier: null,
      enriched_at: new Date().toISOString(),
      enrichment_error: trace,
    },
    result: {
      ok: false,
      linkedin_url: existingLinkedin,
      youtube_url: youtubeUrl,
      email: null,
      email_status: "not_found",
      source: "skipped",
      error: message,
      detail: trace,
    },
  });
}

// Trims a raw error fragment to something readable inside a sentence.
function shorten(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

// Joins a list into a natural-language phrase: "a", "a and b", "a, b, and c".
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function buildHint(niche: string | null, bio: string | null): string {
  const fromNiche = (niche ?? "").trim();
  if (fromNiche.length >= 4) return fromNiche.slice(0, 60);
  const fromBio = (bio ?? "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]{4,}$/.test(w))
    .slice(0, 4)
    .join(" ");
  return fromBio;
}

async function persistAndReturn(opts: {
  leadId: string;
  patch: Record<string, unknown>;
  result: EnrichPipelineResult;
  // When provided, run verification before saving and update email_status + email_verifier
  verify?: { email: string; zerobounceKey: string | null; neverbounceKey: string | null };
}): Promise<EnrichPipelineResult> {
  const sb = createAdminClient();

  if (opts.verify) {
    const vr = await verifyEmail({
      email: opts.verify.email,
      zerobounceKey: opts.verify.zerobounceKey,
      neverbounceKey: opts.verify.neverbounceKey,
    });
    if (vr) {
      opts.patch.email_status = verifyStatusToEmailStatus(vr);
      opts.patch.email_verifier = "provider" in vr ? vr.provider : null;
      opts.result.email_status = opts.patch.email_status as string;
    }
  }

  await sb.from("leads").update(opts.patch).eq("id", opts.leadId);
  return opts.result;
}
