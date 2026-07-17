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
import type { EnrichProgress } from "@/lib/pipeline/enrich-progress";

// Hosts that are recognised as linktree-style aggregators for Step 2.
const LINKTREE_HOSTS = /(?:^|\.)(?:linktr\.ee|geni\.us)/i;

// Matches any YouTube channel URL shape (handle / channel-id / legacy c|user).
const CHANNEL_IN_HTML =
  /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)/gi;

export type TestingPipelineResult = {
  ok: boolean;
  youtube_url: string | null;
  email: string | null;
  email_status: string;
  source: "cached" | "ig_bio" | "youtube" | "not_found";
  error: string | null;
  detail?: string | null;
};

export async function testingEnrichPipeline(opts: {
  leadId: string;
  force?: boolean;
  onStep?: (ev: EnrichProgress) => void;
}): Promise<TestingPipelineResult> {
  const emit = (ev: EnrichProgress) => {
    try { opts.onStep?.(ev); } catch { /* best-effort */ }
  };

  const sb = createAdminClient();
  const { data: lead } = await sb
    .from("leads")
    .select("id, username, full_name, external_link, email, email_status, youtube_url, bio")
    .eq("id", opts.leadId)
    .single();

  if (!lead) {
    return { ok: false, youtube_url: null, email: null, email_status: "error", source: "not_found", error: "Lead not found." };
  }

  const existingYoutube = (lead.youtube_url as string | null) ?? null;

  // Cost-skip: already confirmed.
  if (!opts.force && lead.email && /^(valid|found)$/i.test(lead.email_status as string)) {
    return { ok: true, youtube_url: existingYoutube, email: lead.email as string, email_status: lead.email_status as string, source: "cached", error: null };
  }

  const steps: string[] = [];
  const settings = await getSettings();
  const serperKey = settings.serper_api_key || process.env.SERPER_API_KEY || "";
  const capsolverKey = settings.capsolver_api_key || process.env.CAPSOLVER_API_KEY || "";
  const sbKeys = resolveScrapingBeeKeys(settings);
  const sbKey = sbKeys[0] ?? "";

  const fullName = (lead.full_name as string | null) ?? null;
  const externalLink = (lead.external_link as string | null) ?? null;

  // ── Step 1: email in the Instagram bio. ───────────────────────────────────
  emit({ stage: "bio", state: "start", label: "Instagram bio…" });
  const bioEmail = extractEmailFromText(lead.bio as string | null);
  if (bioEmail) {
    emit({ stage: "bio", state: "hit", label: "Found in bio" });
    return save({ sb, leadId: opts.leadId, patch: { email: bioEmail, email_status: "found", email_provider: "instagram_bio", enriched_at: new Date().toISOString() }, result: { ok: true, youtube_url: existingYoutube, email: bioEmail, email_status: "found", source: "ig_bio", error: null } });
  }
  steps.push("bio: none");

  // ── Step 2 + 3: find YouTube channel URL. ─────────────────────────────────
  // Priority:
  //   2  → linktree/geni.us detected: ScrapingBee JS-render to extract YT link
  //   3  → any other bio link: ScrapingBee static fetch to extract YT link
  //   4  → Serper: "{fullName} youtube.com"
  emit({ stage: "youtube", state: "start", label: "Finding YouTube channel…" });
  let youtubeUrl: string | null = existingYoutube;

  // Direct channel URL in the bio link (cheapest possible case).
  if (!youtubeUrl && externalLink) {
    youtubeUrl = extractYouTubeChannelUrl(externalLink);
    if (youtubeUrl) steps.push("yt_url: direct from bio link");
  }

  // Step 2/3: ScrapingBee fetch of the bio link page.
  if (!youtubeUrl && externalLink && sbKey) {
    const isLinktree = isLinktreeHost(externalLink);
    steps.push(`yt_scrapingbee: fetching bio link (linktree=${isLinktree})`);
    try {
      const { body } = await scrapingBeeGet({
        apiKey: sbKey,
        url: externalLink,
        renderJs: isLinktree, // JS render only for linktree/geni.us (costs more credits)
        premiumProxy: false,
      });
      const decoded = body.replace(/\\\//g, "/").replace(/&amp;/g, "&");
      for (const m of decoded.match(CHANNEL_IN_HTML) ?? []) {
        const canon = extractYouTubeChannelUrl(m);
        if (canon) { youtubeUrl = canon; break; }
      }
      steps.push(youtubeUrl ? `yt_scrapingbee: ${youtubeUrl.slice(0, 50)}` : "yt_scrapingbee: no yt link found");
    } catch (err) {
      steps.push(`yt_scrapingbee: ${(err as Error).message.slice(0, 80)}`);
    }
  } else if (!youtubeUrl && externalLink && !sbKey) {
    steps.push("yt_scrapingbee: skipped (no ScrapingBee key)");
  }

  // Step 4: Serper fallback.
  if (!youtubeUrl && serperKey && fullName) {
    const query = `"${fullName}" youtube.com`;
    steps.push(`yt_serper: searching "${query}"`);
    try {
      const { organic } = await serperSearch({ apiKey: serperKey, query, num: 5, retries: 1 });
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

  // ── Step 5 + 6: YouTube About page email (free then CapSolver gated). ─────
  if (youtubeUrl) {
    emit({ stage: "youtube", state: "start", label: "YouTube About page…" });

    // Build cookie pool.
    const ytCookiePool: string[] = [];
    for (const a of settings.yt_accounts ?? []) {
      const c = a.cookie?.trim();
      if (c && !ytCookiePool.includes(c)) ytCookiePool.push(c);
    }
    for (const c of settings.yt_google_cookies ?? []) { if (c.trim() && !ytCookiePool.includes(c.trim())) ytCookiePool.push(c.trim()); }
    const legacy = (settings.yt_google_cookie || process.env.YT_GOOGLE_COOKIE || "").trim();
    if (legacy && !ytCookiePool.includes(legacy)) ytCookiePool.push(legacy);
    let ytCookie = ytCookiePool[0] ?? "";

    const ytProxy = process.env.YT_REVEAL_PROXY || null;
    // When a persistent Chrome profile is configured, the browser handles DBSC
    // natively — no need to inject (DBSC-bound) cookies that cause HTTP 500.
    const ytProfilePath = process.env.YT_BROWSER_PROFILE_PATH || null;
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

    let attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytCookie, capsolverKey, proxy: ytProxy, profilePath: ytProfilePath });

    // One auto-refresh if the cookie was rejected (only relevant when not using a persistent profile).
    if (attempt.authFailed && !ytProfilePath && youtubeLoginConfigured(settings) && !mintedThisRun) {
      const refreshed = await refreshAndSaveYoutubeCookie();
      if (refreshed.cookie) {
        ytCookie = refreshed.cookie;
        steps.push("yt_cookie_refresh: ok");
        attempt = await attemptYoutubeEmail({ channelUrl: youtubeUrl, googleCookie: ytCookie, capsolverKey, proxy: ytProxy, profilePath: ytProfilePath });
      } else {
        steps.push(`yt_cookie_refresh: ${refreshed.error}`);
      }
    }

    steps.push(...attempt.trace);

    if (attempt.email) {
      emit({ stage: "youtube", state: "hit", label: "Found on YouTube" });
      return save({
        sb,
        leadId: opts.leadId,
        patch: { youtube_url: youtubeUrl, email: attempt.email, email_status: "found", email_provider: attempt.provider, enriched_at: new Date().toISOString() },
        result: { ok: true, youtube_url: youtubeUrl, email: attempt.email, email_status: "found", source: "youtube", error: null },
      });
    }

    // Step 6: no email found even after CapSolver.
    const noEmailMsg = capsolverKey
      ? "No public email on this YouTube About page, even after solving the captcha."
      : "No email visible on the YouTube About page. Add a CapSolver key to attempt the gated reveal.";
    steps.push("yt_about: no email");
    const trace = steps.join(" · ");
    await sb.from("leads").update({ youtube_url: youtubeUrl, email: null, email_status: "not_found", enriched_at: new Date().toISOString(), enrichment_error: trace }).eq("id", opts.leadId);
    return { ok: false, youtube_url: youtubeUrl, email: null, email_status: "not_found", source: "not_found", error: noEmailMsg, detail: trace };
  }

  // No YouTube channel found at all.
  const trace = steps.join(" · ");
  const noChannelMsg = serperKey
    ? "No YouTube channel found via bio link or Google search."
    : "No YouTube channel found. Add a Serper API key to enable Google search fallback.";
  await sb.from("leads").update({ email: null, email_status: "not_found", enriched_at: new Date().toISOString(), enrichment_error: trace }).eq("id", opts.leadId);
  return { ok: false, youtube_url: null, email: null, email_status: "not_found", source: "not_found", error: noChannelMsg, detail: trace };
}

function isLinktreeHost(url: string): boolean {
  try { return LINKTREE_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

async function save(opts: {
  sb: ReturnType<typeof createAdminClient>;
  leadId: string;
  patch: Record<string, unknown>;
  result: TestingPipelineResult;
}): Promise<TestingPipelineResult> {
  await opts.sb.from("leads").update(opts.patch).eq("id", opts.leadId);
  return opts.result;
}
