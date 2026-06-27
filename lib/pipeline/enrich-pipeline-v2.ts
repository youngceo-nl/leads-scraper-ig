import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings, resolveScrapingBeeKeys } from "@/lib/config/settings";
import { extractEmailFromText } from "@/lib/leads/email-extract";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";
import { scrapingBeeGet } from "@/lib/scrapingbee/client";
import { serperSearch } from "@/lib/serper/client";
import { attemptYoutubeEmail } from "@/lib/youtube/email-from-channel";
import {
  refreshAndSaveYoutubeCookie,
  youtubeLoginConfigured,
  checkYoutubeCookieLive,
} from "@/lib/youtube/refresh-cookie";
import { fetchInstagramMobileEmail } from "@/lib/instagram/mobile-email";
import { buildCookiePool } from "@/lib/instagram/cookie-pool";
import type { EnrichProgress } from "@/lib/pipeline/enrich-progress";

// V2 email enrichment pipeline — a focused alternative to the main enrichment
// flow. Checks exactly three sources in order and stops at the first hit:
//   1. Instagram bio text (free)
//   2. YouTube About page — free public scrape, then CapSolver gated reveal
//   3. Instagram mobile "Email" button (public_email field via i.instagram.com)
//
// Results are written to email_v2 / email_v2_* columns so they can be compared
// side-by-side with the v1 results. Never touches email / email_status.

const LINKTREE_HOSTS = /(?:^|\.)(?:linktr\.ee|geni\.us)/i;
const CHANNEL_IN_HTML =
  /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)/gi;

export type EnrichV2Result = {
  ok: boolean;
  youtube_url: string | null;
  email: string | null;
  email_status: string;
  source: "cached" | "ig_bio" | "youtube" | "ig_mobile" | "not_found";
  error: string | null;
  detail?: string | null;
};

export async function enrichPipelineV2(opts: {
  leadId: string;
  force?: boolean;
  onStep?: (ev: EnrichProgress) => void;
}): Promise<EnrichV2Result> {
  const emit = (ev: EnrichProgress) => {
    try { opts.onStep?.(ev); } catch { /* best-effort */ }
  };

  const sb = createAdminClient();
  const { data: lead } = await sb
    .from("leads")
    .select("id, username, full_name, external_link, email_v2, email_v2_status, youtube_url, bio")
    .eq("id", opts.leadId)
    .single();

  if (!lead) {
    return { ok: false, youtube_url: null, email: null, email_status: "error", source: "not_found", error: "Lead not found." };
  }

  const existingYoutube = (lead.youtube_url as string | null) ?? null;

  if (!opts.force && lead.email_v2 && /^(valid|found)$/i.test(lead.email_v2_status as string)) {
    return { ok: true, youtube_url: existingYoutube, email: lead.email_v2 as string, email_status: lead.email_v2_status as string, source: "cached", error: null };
  }

  const steps: string[] = [];
  const settings = await getSettings();
  const serperKey = settings.serper_api_key || process.env.SERPER_API_KEY || "";
  const capsolverKey = settings.capsolver_api_key || process.env.CAPSOLVER_API_KEY || "";
  const sbKeys = resolveScrapingBeeKeys(settings);
  const sbKey = sbKeys[0] ?? "";

  const username = (lead.username as string | null) ?? null;
  const fullName = (lead.full_name as string | null) ?? null;
  const externalLink = (lead.external_link as string | null) ?? null;

  // ── Step 1: email in the Instagram bio. ───────────────────────────────────
  emit({ stage: "bio", state: "start", label: "Instagram bio…" });
  const bioEmail = extractEmailFromText(lead.bio as string | null);
  if (bioEmail) {
    emit({ stage: "bio", state: "hit", label: "Found in bio" });
    return saveV2(sb, opts.leadId, existingYoutube, {
      email_v2: bioEmail, email_v2_status: "found", email_v2_provider: "ig_bio",
      email_v2_enriched_at: now(), email_v2_error: null,
    }, { ok: true, youtube_url: existingYoutube, email: bioEmail, email_status: "found", source: "ig_bio", error: null });
  }
  steps.push("bio: none");

  // ── Step 2: resolve YouTube channel URL. ──────────────────────────────────
  emit({ stage: "youtube", state: "start", label: "Finding YouTube channel…" });
  let youtubeUrl: string | null = existingYoutube;

  if (!youtubeUrl && externalLink) {
    youtubeUrl = extractYouTubeChannelUrl(externalLink);
    if (youtubeUrl) steps.push("yt_url: direct from bio link");
  }

  if (!youtubeUrl && externalLink && sbKey) {
    const isLinktree = isLinktreeHost(externalLink);
    try {
      const { body } = await scrapingBeeGet({ apiKey: sbKey, url: externalLink, renderJs: isLinktree, premiumProxy: false });
      const decoded = body.replace(/\\\//g, "/").replace(/&amp;/g, "&");
      for (const m of decoded.match(CHANNEL_IN_HTML) ?? []) {
        const canon = extractYouTubeChannelUrl(m);
        if (canon) { youtubeUrl = canon; break; }
      }
      steps.push(youtubeUrl ? `yt_scrapingbee: ${youtubeUrl.slice(0, 50)}` : "yt_scrapingbee: no yt link");
    } catch (err) {
      steps.push(`yt_scrapingbee: ${(err as Error).message.slice(0, 80)}`);
    }
  } else if (!youtubeUrl && externalLink && !sbKey) {
    steps.push("yt_scrapingbee: skipped (no SB key)");
  }

  if (!youtubeUrl && serperKey && fullName) {
    try {
      const { organic } = await serperSearch({ apiKey: serperKey, query: `"${fullName}" youtube.com`, num: 5, retries: 1 });
      for (const r of organic) {
        const canon = r.link ? extractYouTubeChannelUrl(r.link) : null;
        if (canon) { youtubeUrl = canon; break; }
      }
      steps.push(youtubeUrl ? `yt_serper: ${youtubeUrl.slice(0, 50)}` : "yt_serper: not found");
    } catch (err) {
      steps.push(`yt_serper: ${(err as Error).message.slice(0, 80)}`);
    }
  } else if (!youtubeUrl && !serperKey) {
    steps.push("yt_serper: skipped (no Serper key)");
  } else if (!youtubeUrl && !fullName) {
    steps.push("yt_serper: skipped (no full name)");
  }

  // ── Step 2b: YouTube About page (free + gated). ───────────────────────────
  if (youtubeUrl) {
    emit({ stage: "youtube", state: "start", label: "YouTube About page…" });

    const ytCookiePool: string[] = [];
    for (const a of settings.yt_accounts ?? []) {
      const c = a.cookie?.trim();
      if (c && !ytCookiePool.includes(c)) ytCookiePool.push(c);
    }
    for (const c of settings.yt_google_cookies ?? []) {
      if (c.trim() && !ytCookiePool.includes(c.trim())) ytCookiePool.push(c.trim());
    }
    const legacy = (settings.yt_google_cookie || process.env.YT_GOOGLE_COOKIE || "").trim();
    if (legacy && !ytCookiePool.includes(legacy)) ytCookiePool.push(legacy);
    let ytCookie = ytCookiePool[0] ?? "";

    const ytProxy = process.env.YT_REVEAL_PROXY || null;
    let mintedThisRun = false;

    if (youtubeLoginConfigured(settings)) {
      const liveness = ytCookie ? await checkYoutubeCookieLive(ytCookie) : "dead";
      steps.push(`yt_cookie_check: ${ytCookie ? liveness : "absent"}`);
      if (liveness === "dead") {
        const minted = await refreshAndSaveYoutubeCookie();
        if (minted.cookie) { ytCookie = minted.cookie; mintedThisRun = true; steps.push("yt_cookie_refresh: minted"); }
        else steps.push(`yt_cookie_refresh: ${minted.error}`);
      }
    }

    let attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytCookie, capsolverKey, proxy: ytProxy });

    if (attempt.authFailed && youtubeLoginConfigured(settings) && !mintedThisRun) {
      const refreshed = await refreshAndSaveYoutubeCookie();
      if (refreshed.cookie) {
        ytCookie = refreshed.cookie;
        steps.push("yt_cookie_refresh: ok");
        attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytCookie, capsolverKey, proxy: ytProxy });
      } else {
        steps.push(`yt_cookie_refresh: ${refreshed.error}`);
      }
    }

    steps.push(...attempt.trace);

    if (attempt.email) {
      emit({ stage: "youtube", state: "hit", label: "Found on YouTube" });
      return saveV2(sb, opts.leadId, youtubeUrl, {
        email_v2: attempt.email, email_v2_status: "found", email_v2_provider: attempt.provider ?? "youtube",
        email_v2_enriched_at: now(), email_v2_error: null,
      }, { ok: true, youtube_url: youtubeUrl, email: attempt.email, email_status: "found", source: "youtube", error: null });
    }

    steps.push("yt_about: no email");
  } else {
    steps.push("yt_about: skipped (no channel found)");
  }

  // ── Step 3: Instagram mobile "Email" button (public_email). ───────────────
  emit({ stage: "ig_mobile", state: "start", label: "Instagram contact email…" });

  // Use the same cookie pool as the main pipeline — respects active_account_group.
  const igCookiePool = buildCookiePool(settings);
  const igCookies = igCookiePool.map((e) => ({ cookie: e.cookie, proxy: e.proxyUrl }));

  if (!username) {
    steps.push("ig_mobile: skipped (no username)");
  } else if (igCookies.length === 0) {
    steps.push("ig_mobile: skipped (no IG session cookie configured)");
  } else {
    let mobileEmail: string | null = null;
    let mobileError: string | null = null;

    for (const { cookie, proxy } of igCookies) {
      const result = await fetchInstagramMobileEmail({ username, sessionCookie: cookie, proxyUrl: proxy });
      if (result.email) { mobileEmail = result.email; break; }
      mobileError = result.error;
      // Continue to next account only on rate limit; stop on definitive answers
      if (result.error !== "rate_limited") break;
    }

    steps.push(`ig_mobile: ${mobileEmail ? mobileEmail.slice(0, 40) : (mobileError ?? "none")}`);

    if (mobileEmail) {
      emit({ stage: "ig_mobile", state: "hit", label: "Found via Instagram" });
      return saveV2(sb, opts.leadId, youtubeUrl, {
        email_v2: mobileEmail, email_v2_status: "found", email_v2_provider: "ig_mobile",
        email_v2_enriched_at: now(), email_v2_error: null,
      }, { ok: true, youtube_url: youtubeUrl, email: mobileEmail, email_status: "found", source: "ig_mobile", error: null });
    }

    emit({ stage: "ig_mobile", state: "miss", label: "No contact email set" });
  }

  // ── Nothing found. ────────────────────────────────────────────────────────
  const trace = steps.join(" · ");

  const problems: string[] = [];
  if (igCookies.length === 0) problems.push("Add an Instagram session cookie in Settings to enable the mobile contact email lookup.");
  if (!serperKey) problems.push("Add a Serper API key in Settings to search Google for their YouTube channel.");
  if (youtubeUrl && !capsolverKey) problems.push("Add a CapSolver API key in Settings to reveal gated YouTube emails.");

  const message = problems.length > 0
    ? `No email found. ${problems.join(" ")}`
    : "No public email found. Checked IG bio, YouTube About, and Instagram contact email — none publish one.";

  await sb.from("leads").update({
    youtube_url: youtubeUrl,
    email_v2: null,
    email_v2_status: "not_found",
    email_v2_provider: null,
    email_v2_enriched_at: now(),
    email_v2_error: trace,
  }).eq("id", opts.leadId);

  return { ok: false, youtube_url: youtubeUrl, email: null, email_status: "not_found", source: "not_found", error: message, detail: trace };
}

function isLinktreeHost(url: string): boolean {
  try { return LINKTREE_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

function now(): string { return new Date().toISOString(); }

async function saveV2(
  sb: ReturnType<typeof createAdminClient>,
  leadId: string,
  youtubeUrl: string | null,
  patch: Record<string, unknown>,
  result: EnrichV2Result,
): Promise<EnrichV2Result> {
  await sb.from("leads").update({ youtube_url: youtubeUrl, ...patch }).eq("id", leadId);
  return result;
}
