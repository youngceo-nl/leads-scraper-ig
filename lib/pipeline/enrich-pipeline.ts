import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { findLinkedInUrl } from "@/lib/linkedin/find";
import { extractLinkedInProfileUrl } from "@/lib/linkedin/profile-url";
import { findYouTubeChannel } from "@/lib/youtube/find";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";
import { fetchYouTubeAboutWithCookie } from "@/lib/youtube/about-cookie";
import { scrapeWebsiteForEmail } from "@/lib/website/scrape-email";
import { extractEmailFromText } from "@/lib/leads/email-extract";
import { deriveInputs, findEmail, findEmailByLinkedInUrl } from "@/lib/airscale/enrich";

export type EnrichPipelineResult = {
  ok: boolean;
  linkedin_url: string | null;
  youtube_url: string | null;
  email: string | null;
  email_status: string;
  source: "cached" | "ig_bio" | "website" | "youtube" | "linkedin" | "domain" | "skipped";
  error: string | null;
};

export async function enrichLeadPipeline(opts: {
  leadId: string;
  force?: boolean;
}): Promise<EnrichPipelineResult> {
  const sb = createAdminClient();
  const { data: lead } = await sb
    .from("leads")
    .select("id, username, full_name, external_link, funnel_url, email, email_status, linkedin_url, youtube_url, niche, bio")
    .eq("id", opts.leadId)
    .single();
  if (!lead) {
    return { ok: false, linkedin_url: null, youtube_url: null, email: null, email_status: "error", source: "skipped", error: "lead_not_found" };
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
  const bioEmail = extractEmailFromText(lead.bio as string | null);
  if (bioEmail) {
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
  const airscaleKey = settings.airscale_api_key || process.env.AIRSCALE_API_KEY || "";
  const capsolverKey = settings.capsolver_api_key || process.env.CAPSOLVER_API_KEY || "";
  const ytGoogleCookie = settings.yt_google_cookie || process.env.YT_GOOGLE_COOKIE || "";

  const username = (lead.username as string | null) ?? null;
  const externalLink = (lead.external_link as string | null) ?? null;
  const funnelUrl = (lead.funnel_url as string | null) ?? null;
  const fullName = (lead.full_name as string | null) ?? null;
  const tokens = fullName?.trim().split(/\s+/).filter(Boolean) ?? [];

  // ── Step 2: scrape the website linked in their bio / funnel URL (free). ───
  let websiteScraped = false;
  for (const url of [externalLink, funnelUrl]) {
    if (!url || extractYouTubeChannelUrl(url) || url.includes("linkedin.com")) continue;
    websiteScraped = true;
    const { email: siteEmail, error: siteErr } = await scrapeWebsiteForEmail(url);
    if (siteEmail) {
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
        result: { ok: true, linkedin_url: existingLinkedin, youtube_url: existingYoutube, email: siteEmail, email_status: "found", source: "website", error: null },
      });
    }
    steps.push(`website(${url.slice(0, 40)}): ${siteErr ?? "none"}`);
  }
  if (!websiteScraped) steps.push("website: skipped (no link or is YT/LI)");

  // ── Steps 3 & 4: resolve the YouTube channel, then scrape its About page. ──
  let youtubeUrl: string | null = existingYoutube;
  let youtubeError: string | null = null;

  if (!youtubeUrl) {
    youtubeUrl = extractYouTubeChannelUrl(externalLink);
    if (youtubeUrl) steps.push("yt_url: from bio link");
  }
  if (!youtubeUrl && serperKey && (tokens.length >= 2 || username)) {
    const hint = buildHint(lead.niche as string | null, lead.bio as string | null);
    const lookup = await findYouTubeChannel({ apiKey: serperKey, fullName, username, hints: hint });
    youtubeUrl = lookup.url;
    youtubeError = lookup.error;
    steps.push(`yt_serper: ${youtubeUrl ? youtubeUrl.slice(0, 50) : (lookup.error ?? "not found")}`);
  } else if (!youtubeUrl && !serperKey) {
    steps.push("yt_serper: skipped (no Serper key)");
  }

  if (youtubeUrl && ytGoogleCookie) {
    const cookieScrape = await fetchYouTubeAboutWithCookie({ channelUrl: youtubeUrl, googleCookie: ytGoogleCookie });
    if (cookieScrape.email) {
      return persistAndReturn({
        leadId: opts.leadId,
        patch: {
          youtube_url: youtubeUrl,
          youtube_lookup_error: null,
          email: cookieScrape.email,
          email_status: "found",
          email_provider: "youtube_about",
          email_verifier: null,
          enriched_at: new Date().toISOString(),
          enrichment_error: null,
        },
        result: { ok: true, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: cookieScrape.email, email_status: "found", source: "youtube", error: null },
      });
    }
    steps.push(`yt_cookie_scrape: ${cookieScrape.error ?? "none"}`);
    youtubeError = youtubeError ?? cookieScrape.error;
  } else if (youtubeUrl && !ytGoogleCookie) {
    steps.push("yt_cookie_scrape: skipped (no YT cookie)");
  } else if (!youtubeUrl) {
    steps.push("yt_cookie_scrape: skipped (no channel found)");
  }

  if (youtubeUrl && capsolverKey && ytGoogleCookie) {
    try {
      const { revealYoutubeEmail } = await import("@/lib/youtube/reveal-email");
      const revealed = await revealYoutubeEmail({
        channelUrl: youtubeUrl,
        googleCookie: ytGoogleCookie,
        capsolverKey,
        proxy: process.env.YT_REVEAL_PROXY || null,
      });
      if (revealed.email) {
        return persistAndReturn({
          leadId: opts.leadId,
          patch: {
            youtube_url: youtubeUrl,
            youtube_lookup_error: null,
            email: revealed.email,
            email_status: "found",
            email_provider: "youtube_about_gated",
            email_verifier: null,
            enriched_at: new Date().toISOString(),
            enrichment_error: null,
          },
          result: { ok: true, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: revealed.email, email_status: "found", source: "youtube", error: null },
        });
      }
      steps.push(`yt_capsolver: ${revealed.error ?? "none"}`);
      youtubeError = youtubeError ?? revealed.error;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 100);
      steps.push(`yt_capsolver: failed (${msg})`);
      youtubeError = youtubeError ?? `reveal_failed: ${msg}`;
    }
  } else if (youtubeUrl && (!capsolverKey || !ytGoogleCookie)) {
    steps.push(`yt_capsolver: skipped (${!capsolverKey ? "no CapSolver key" : "no YT cookie"})`);
  }

  // ── Steps 5 & 6: LinkedIn discovery + AirScale lookup (paid, last resort). ─
  if (!airscaleKey) {
    const trace = steps.join(" · ") + " · airscale: not configured";
    return persistAndReturn({
      leadId: opts.leadId,
      patch: { youtube_url: youtubeUrl, youtube_lookup_error: youtubeError, enrichment_error: trace },
      result: { ok: false, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: null, email_status: "error", source: "skipped", error: trace },
    });
  }

  let linkedinUrl: string | null = existingLinkedin;
  let linkedinError: string | null = null;

  if (!linkedinUrl) {
    linkedinUrl = extractLinkedInProfileUrl(externalLink);
    if (linkedinUrl) steps.push("li_url: from bio link");
  }
  if (!linkedinUrl && serperKey && (tokens.length >= 2 || username)) {
    const hint = buildHint(lead.niche as string | null, lead.bio as string | null);
    const lookup = await findLinkedInUrl({ apiKey: serperKey, fullName, username, hints: hint });
    linkedinUrl = lookup.url;
    linkedinError = lookup.error;
    steps.push(`li_serper: ${linkedinUrl ? linkedinUrl.slice(0, 50) : (lookup.error ?? "not found")}`);
  } else if (!linkedinUrl && !serperKey) {
    linkedinError = "skipped:no_serper_key";
    steps.push("li_serper: skipped (no Serper key)");
  }

  if (linkedinUrl) {
    const first = tokens[0] ?? null;
    const last = tokens.length >= 2 ? tokens[tokens.length - 1] : null;
    const result = await findEmailByLinkedInUrl({
      apiKey: airscaleKey,
      linkedinUrl,
      firstName: first,
      lastName: last,
      leadId: opts.leadId,
    });
    if (result.email) {
      return persistAndReturn({
        leadId: opts.leadId,
        patch: {
          linkedin_url: linkedinUrl,
          linkedin_lookup_error: null,
          youtube_url: youtubeUrl,
          youtube_lookup_error: youtubeError,
          email: result.email,
          email_status: result.email_status,
          email_provider: result.email_provider,
          email_verifier: result.email_verifier,
          enriched_at: new Date().toISOString(),
          enrichment_error: null,
        },
        result: { ok: true, linkedin_url: linkedinUrl, youtube_url: youtubeUrl, email: result.email, email_status: result.email_status, source: "linkedin", error: null },
      });
    }
    steps.push(`airscale_li: ${result.email_status}`);
    linkedinError = linkedinError ?? `airscale_linkedin:${result.email_status}`;
  }

  const inputs = deriveInputs({ full_name: fullName, external_link: lead.external_link as string | null });
  const fallback = await findEmail({ apiKey: airscaleKey, inputs, leadId: opts.leadId });
  steps.push(`airscale_domain: ${fallback.email_status}`);

  const trace = steps.join(" · ");
  return persistAndReturn({
    leadId: opts.leadId,
    patch: {
      linkedin_url: linkedinUrl,
      linkedin_lookup_error: linkedinError,
      youtube_url: youtubeUrl,
      youtube_lookup_error: youtubeError,
      email: fallback.email,
      email_status: fallback.email_status,
      email_provider: fallback.email_provider,
      email_verifier: fallback.email_verifier,
      enriched_at: new Date().toISOString(),
      enrichment_error: fallback.error ? `${fallback.error} · ${trace}` : trace,
    },
    result: {
      ok: !fallback.error,
      linkedin_url: linkedinUrl,
      youtube_url: youtubeUrl,
      email: fallback.email,
      email_status: fallback.email_status,
      source: linkedinUrl ? "linkedin" : "domain",
      error: fallback.error ? `${fallback.error} · ${trace}` : null,
    },
  });
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
