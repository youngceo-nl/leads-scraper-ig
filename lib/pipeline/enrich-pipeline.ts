import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { findLinkedInUrl } from "@/lib/linkedin/find";
import { extractLinkedInProfileUrl } from "@/lib/linkedin/profile-url";
import { findYouTubeChannel } from "@/lib/youtube/find";
import { extractYouTubeChannelUrl } from "@/lib/youtube/channel-url";
import { findYouTubeChannelEmail } from "@/lib/youtube/about";
import { extractEmailFromText } from "@/lib/leads/email-extract";
import { deriveInputs, findEmail, findEmailByLinkedInUrl } from "@/lib/airscale/enrich";

export type EnrichPipelineResult = {
  ok: boolean;
  linkedin_url: string | null;
  youtube_url: string | null;
  email: string | null;
  email_status: string;
  source: "cached" | "ig_bio" | "youtube" | "linkedin" | "domain" | "skipped";
  error: string | null;
};

export async function enrichLeadPipeline(opts: {
  leadId: string;
  force?: boolean;
}): Promise<EnrichPipelineResult> {
  const sb = createAdminClient();
  const { data: lead } = await sb
    .from("leads")
    .select("id, username, full_name, external_link, email, email_status, linkedin_url, youtube_url, niche, bio")
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

  const settings = await getSettings();
  const scrapingBeeKey = settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY || "";
  const serperKey = settings.serper_api_key || process.env.SERPER_API_KEY || "";
  const airscaleKey = settings.airscale_api_key || process.env.AIRSCALE_API_KEY || "";

  const username = (lead.username as string | null) ?? null;
  const externalLink = (lead.external_link as string | null) ?? null;
  const fullName = (lead.full_name as string | null) ?? null;
  const tokens = fullName?.trim().split(/\s+/).filter(Boolean) ?? [];

  // ── Steps 2 & 3: resolve the YouTube channel, then read a plaintext email ──
  //    off its public About page.
  let youtubeUrl: string | null = existingYoutube;
  let youtubeError: string | null = null;

  // (a) Free: the channel may already be the IG bio's external_link.
  if (!youtubeUrl) {
    youtubeUrl = extractYouTubeChannelUrl(externalLink);
  }
  // (b) Paid SERP: search by full name, or by IG username for single-name leads.
  if (!youtubeUrl && serperKey && (tokens.length >= 2 || username)) {
    const hint = buildHint(lead.niche as string | null, lead.bio as string | null);
    const lookup = await findYouTubeChannel({ apiKey: serperKey, fullName, username, hints: hint });
    youtubeUrl = lookup.url;
    youtubeError = lookup.error;
  }
  // (c) Scrape the About page for a plaintext email (needs ScrapingBee).
  if (youtubeUrl && scrapingBeeKey) {
    const ytEmail = await findYouTubeChannelEmail({ apiKey: scrapingBeeKey, channelUrl: youtubeUrl });
    if (ytEmail.email) {
      return persistAndReturn({
        leadId: opts.leadId,
        patch: {
          youtube_url: youtubeUrl,
          youtube_lookup_error: null,
          email: ytEmail.email,
          email_status: "found",
          email_provider: "youtube_about",
          email_verifier: null,
          enriched_at: new Date().toISOString(),
          enrichment_error: null,
        },
        result: { ok: true, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: ytEmail.email, email_status: "found", source: "youtube", error: null },
      });
    }
    youtubeError = youtubeError ?? ytEmail.error;
  }

  // ── Steps 4 & 5: LinkedIn discovery + AirScale lookup (paid, last resort). ─
  if (!airscaleKey) {
    return persistAndReturn({
      leadId: opts.leadId,
      patch: { youtube_url: youtubeUrl, youtube_lookup_error: youtubeError, enrichment_error: "AirScale API key not configured" },
      result: { ok: false, linkedin_url: existingLinkedin, youtube_url: youtubeUrl, email: null, email_status: "error", source: "skipped", error: "AirScale API key not configured" },
    });
  }

  let linkedinUrl: string | null = existingLinkedin;
  let linkedinError: string | null = null;

  // Step 4a — free: the IG bio's external_link may already be a LinkedIn profile.
  if (!linkedinUrl) {
    linkedinUrl = extractLinkedInProfileUrl(externalLink);
  }
  // Step 4b — paid SERP: search by full name, or by IG username for single-name leads.
  if (!linkedinUrl && serperKey && (tokens.length >= 2 || username)) {
    const hint = buildHint(lead.niche as string | null, lead.bio as string | null);
    const lookup = await findLinkedInUrl({ apiKey: serperKey, fullName, username, hints: hint });
    linkedinUrl = lookup.url;
    linkedinError = lookup.error;
  } else if (!linkedinUrl && !serperKey) {
    linkedinError = "skipped:no_serper_key";
  }

  // Step 5a — AirScale via LinkedIn URL if we have one.
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
    // LinkedIn AirScale call returned no email — fall through to domain fallback.
    linkedinError = linkedinError ?? `airscale_linkedin:${result.email_status}`;
  }

  // Step 5b — classic name + IG external_link domain.
  const inputs = deriveInputs({ full_name: fullName, external_link: lead.external_link as string | null });
  const fallback = await findEmail({ apiKey: airscaleKey, inputs, leadId: opts.leadId });

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
      enrichment_error: fallback.error,
    },
    result: {
      ok: !fallback.error,
      linkedin_url: linkedinUrl,
      youtube_url: youtubeUrl,
      email: fallback.email,
      email_status: fallback.email_status,
      source: linkedinUrl ? "linkedin" : "domain",
      error: fallback.error,
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
