import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { findYouTubeChannel } from "@/lib/youtube/find";
import { inferRealName } from "@/lib/youtube/infer-name";
import { findYouTubeChannelFromPage } from "@/lib/youtube/from-page";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";
import { attemptYoutubeEmail } from "@/lib/youtube/email-from-channel";
import { refreshAndSaveYoutubeCookie, youtubeLoginConfigured, checkYoutubeCookieLive } from "@/lib/youtube/refresh-cookie";
import { scrapeWebsiteForEmail } from "@/lib/website/scrape-email";
import { extractEmailFromText } from "@/lib/leads/email-extract";
import { inferEmailFromDomain, extractDomain } from "@/lib/email/domain-inference";
import { findEmailWithHunter } from "@/lib/email/hunter";
import type { EnrichProgress } from "@/lib/pipeline/enrich-progress";

export type EnrichPipelineResult = {
  ok: boolean;
  linkedin_url: string | null;
  youtube_url: string | null;
  email: string | null;
  email_status: string;
  source: "cached" | "ig_bio" | "website" | "youtube" | "domain_inference" | "hunter" | "skipped";
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
    });
  }
  steps.push("bio: none");

  const settings = await getSettings();
  const serperKey = settings.serper_api_key || process.env.SERPER_API_KEY || "";
  const capsolverKey = settings.capsolver_api_key || process.env.CAPSOLVER_API_KEY || "";
  const openAiKey = settings.openai_api_key || process.env.OPENAI_API_KEY || "";

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
      const { fetchProfileMetadataDirect } = await import("@/lib/instagram/direct");
      const meta = await fetchProfileMetadataDirect({ username, sessionCookie: igCookie, skipReels: true });
      if (meta?.external_link) {
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
    if (attempt.authFailed && youtubeLoginConfigured(settings) && !mintedThisRun) {
      const refreshed = await refreshAndSaveYoutubeCookie();
      if (refreshed.cookie) {
        ytGoogleCookie = refreshed.cookie;
        steps.push("yt_cookie_refresh: ok");
        attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytGoogleCookie, capsolverKey, proxy: ytProxy });
      } else {
        steps.push(`yt_cookie_refresh: ${refreshed.error}`);
      }
    }

    steps.push(...attempt.trace);
    if (attempt.email && attempt.provider) {
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

  // ── Step 3: scrape the website linked in their bio / funnel URL (free). ───
  const hasSite = [externalLink, funnelUrl].some(
    (u) => u && !extractYouTubeChannelUrl(u) && !u.includes("linkedin.com"),
  );
  if (hasSite) emit({ stage: "website", state: "start", label: "Their website…" });
  let websiteScraped = false;
  for (const url of [externalLink, funnelUrl]) {
    if (!url || extractYouTubeChannelUrl(url) || url.includes("linkedin.com")) continue;
    websiteScraped = true;
    const { email: siteEmail, error: siteErr } = await scrapeWebsiteForEmail(url);
    if (siteEmail) {
      emit({ stage: "website", state: "hit", label: "Found on website" });
      return persistAndReturn({
        leadId: opts.leadId,
        patch: {
          email: siteEmail,
          email_status: "found",
          email_provider: "website_scrape",
          email_verifier: null,
          enriched_at: new Date().toISOString(),
          enrichment_error: null,
        },
        result: { ok: true, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: siteEmail, email_status: "found", source: "website", error: null },
      });
    }
    steps.push(`website(${url.slice(0, 40)}): ${siteErr ?? "none"}`);
  }
  if (!websiteScraped) steps.push("website: skipped (no link or is YT/LI)");

  // ── Step 4: domain + name inference — last resort (Hunter.io if key set, else free DNS guess). ──
  {
    const hunterKey = settings.hunter_api_key || process.env.HUNTER_API_KEY || "";
    const domain = extractDomain(externalLink ?? funnelUrl);

    if (domain) {
      emit({ stage: "domain_inference", state: "start", label: hunterKey ? "Hunter.io…" : "Domain lookup…" });

      let inferredEmail: string | null = null;
      let inferSource: "hunter" | "domain_inference" = "domain_inference";

      if (hunterKey) {
        const r = await findEmailWithHunter({ apiKey: hunterKey, domain, fullName });
        if (r.email) {
          inferredEmail = r.email;
          inferSource = "hunter";
          steps.push(`hunter: ${r.email} (score=${"score" in r ? r.score : "?"})`);
        } else {
          steps.push(`hunter: ${"reason" in r ? r.reason : "no_email"}`);
        }
      }

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
        emit({ stage: "domain_inference", state: "hit", label: hunterKey ? "Found via Hunter" : "Inferred from domain" });
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
            linkedin_url: existingLinkedin,
            youtube_url: youtubeUrl,
            email: inferredEmail,
            email_status: "inferred",
            source: inferSource,
            error: null,
          },
        });
      }
    } else {
      steps.push("domain_inference: skipped (no personal domain)");
    }
  }

  // ── Nothing turned up through any of the available (free) public sources. ──
  // Email enrichment relies only on what people publish themselves: the
  // Instagram bio, the website linked in their bio, and their YouTube About
  // page. Build a clear, human-readable explanation of what we tried — and,
  // when a lookup was skipped because an integration isn't set up, say exactly
  // what to configure so the user can act on it.
  const checked: string[] = ["the Instagram bio"];
  if (websiteScraped) checked.push("the website in their bio");
  if (youtubeUrl) checked.push("their YouTube About page");

  // Surface the most actionable problem first. A blocked/misconfigured lookup
  // is far more useful to the user than a generic "nothing found".
  const problems: string[] = [];

  // 1) YouTube session cookie is invalid / expired / logged out — the single
  //    most common reason the gated reveal can't run.
  const cookieBroken =
    ytAuthFailed || (!!ytGatedError && /invalid cookie|addcookies|setcookies|not signed in|logged out/i.test(ytGatedError));
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

  // 6) The website in their bio couldn't be read (timeout/blocked) — distinct
  //    from "we read it and there was no email".
  const siteErr = steps.find((s) => s.startsWith("website(") && !/: (no_email_found|none)$/.test(s));
  if (siteErr) {
    const reason = siteErr.replace(/^website\([^)]*\):\s*/, "");
    problems.push(`We couldn't fully read the website in their bio (${shorten(reason)}).`);
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
}): Promise<EnrichPipelineResult> {
  const sb = createAdminClient();
  await sb.from("leads").update(opts.patch).eq("id", opts.leadId);
  return opts.result;
}
