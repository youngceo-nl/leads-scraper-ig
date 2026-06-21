import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { fetchFunnelPage } from "./fetch";
import { classifyFunnel } from "./classify";
import { pickBestFunnelLink } from "./drill";
import { extractFunnel } from "./extract";
import { llmExtractFunnel } from "./llm-extract";
import { freeFetchPage } from "./free-fetch";
import { extractProgramNameFromUrl } from "./program-name-from-url";

export type FunnelEnrichmentResult = {
  ok: boolean;
  funnel_url: string | null;
  funnel_platform: string | null;
  funnel_program_name: string | null;
  funnel_offer_summary: string | null;
  funnel_price: string | null;
  error: string | null;
};

type FunnelData = {
  funnel_url: string;
  funnel_platform: string;
  program: { program_name: string | null; offer_summary: string | null; price: string | null };
  error: string | null;
};

export async function enrichFunnelForLead(opts: {
  leadId: string;
  externalLink: string;
}): Promise<FunnelEnrichmentResult> {
  // Step 1: domain/URL-based name — instant, zero cost
  const domainName = extractProgramNameFromUrl(opts.externalLink);

  try {
    // Step 2: free raw HTTP fetch (no ScrapingBee credits)
    const freeResult = await tryFreeTier(opts.externalLink, domainName);
    if (freeResult) {
      return persistResult({ leadId: opts.leadId, ...freeResult });
    }

    // Step 3: ScrapingBee (JS rendering, behind Cloudflare, etc.)
    const settings = await getSettings();
    const apiKey = settings.scrapingbee_api_key || process.env.SCRAPINGBEE_API_KEY || "";

    if (!apiKey) {
      return persistError(opts.leadId, "ScrapingBee API key not configured");
    }

    // --- ScrapingBee path ---
    const entry = await fetchFunnelPage({ apiKey, url: opts.externalLink });
    const entryClass = classifyFunnel({ url: entry.finalUrl, html: entry.html });

    let pageUrl = entry.finalUrl;
    let pageHtml = entry.html;
    let platform = entryClass.platform;

    if (entryClass.isAggregator) {
      const child = pickBestFunnelLink({ aggregatorUrl: entry.finalUrl, html: entry.html });
      if (!child) {
        return persistResult({
          leadId: opts.leadId,
          funnel_url: entry.finalUrl,
          funnel_platform: entryClass.platform,
          program: { program_name: domainName, offer_summary: null, price: null },
          error: "no_drill_candidate",
        });
      }
      const drilled = await fetchFunnelPage({ apiKey, url: child });
      pageUrl = drilled.finalUrl;
      pageHtml = drilled.html;
      platform = classifyFunnel({ url: drilled.finalUrl, html: drilled.html }).platform;
    }

    const cheap = extractFunnel({ html: pageHtml, platform });
    let program_name = cheap.program_name ?? domainName;
    let offer_summary = cheap.offer_summary;
    let price = cheap.price;

    if (!cheap.good_enough) {
      try {
        const { extraction } = await llmExtractFunnel({
          settings,
          url: pageUrl,
          platform,
          hints: { program_name, offer_summary, price },
          pageText: cheap.raw_text_for_llm,
          leadId: opts.leadId,
        });
        if (extraction.confidence !== "none") {
          program_name = extraction.program_name ?? program_name;
          offer_summary = extraction.offer_summary ?? offer_summary;
          price = extraction.price ?? price;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return persistResult({
          leadId: opts.leadId,
          funnel_url: pageUrl,
          funnel_platform: platform,
          program: { program_name, offer_summary, price },
          error: `llm_failed: ${msg.slice(0, 200)}`,
        });
      }
    }

    return persistResult({
      leadId: opts.leadId,
      funnel_url: pageUrl,
      funnel_platform: platform,
      program: { program_name, offer_summary, price },
      error: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return persistError(opts.leadId, msg);
  }
}

// Attempts to enrich using only free HTTP fetches (no ScrapingBee).
// Returns a FunnelData object if we got something useful, null otherwise.
async function tryFreeTier(
  externalLink: string,
  domainFallback: string | null,
): Promise<FunnelData | null> {
  const fetched = await freeFetchPage(externalLink);
  if (!fetched) return null;

  const classify = classifyFunnel({ url: fetched.finalUrl, html: fetched.html });

  if (!classify.isAggregator) {
    return extractFromPage(fetched.finalUrl, fetched.html, classify.platform, domainFallback);
  }

  // Aggregator: try drilling to a child link first
  const childUrl = pickBestFunnelLink({ aggregatorUrl: fetched.finalUrl, html: fetched.html });
  if (childUrl) {
    const childFetched = await freeFetchPage(childUrl);
    if (childFetched) {
      const childClassify = classifyFunnel({ url: childFetched.finalUrl, html: childFetched.html });
      const childDomainName = extractProgramNameFromUrl(childFetched.finalUrl);
      const childResult = extractFromPage(
        childFetched.finalUrl,
        childFetched.html,
        childClassify.platform,
        childDomainName ?? domainFallback,
      );
      if (childResult) return childResult;
    }
  }

  // No good child — extract from the aggregator page itself (person/brand name from og:title)
  const aggResult = extractFromPage(fetched.finalUrl, fetched.html, classify.platform, domainFallback);
  if (aggResult?.program.program_name) {
    const cleaned = cleanAggregatorTitle(aggResult.program.program_name);
    if (cleaned) {
      aggResult.program.program_name = cleaned;
      return aggResult;
    }
  }

  return null;
}

// Strips common aggregator platform suffixes from og:title values.
// e.g. "Christa Miller (@clynn69) | Stan" → "Christa Miller"
// e.g. "thehouserealty Official: TikTok, Instagram | Linktree" → "thehouserealty"
function cleanAggregatorTitle(title: string): string | null {
  const cleaned = title
    .replace(/\s*Official:\s*.+$/i, "")
    .replace(/\s*\|\s*(Linktree|Stan|Beacons?|Whop|Bio\.link|Campsite)\s*$/i, "")
    .replace(/\s*\(@[^)]+\)\s*/g, "")
    .trim();
  if (cleaned.length < 3 || cleaned === title.trim()) return cleaned.length >= 3 ? cleaned : null;
  return cleaned;
}

function extractFromPage(
  url: string,
  html: string,
  platform: string,
  domainFallback: string | null,
): FunnelData | null {
  const cheap = extractFunnel({ html, platform });
  const program_name = cheap.program_name ?? domainFallback;

  // Return something useful if we have at least a name or a summary
  if (!program_name && !cheap.offer_summary) return null;

  return {
    funnel_url: url,
    funnel_platform: platform,
    program: { program_name, offer_summary: cheap.offer_summary, price: cheap.price },
    error: null,
  };
}

// Reject names that are clearly not a real program offer.
function sanitizeProgramName(name: string | null): string | null {
  if (!name) return null;
  const s = name.trim();
  if (s.length < 3 || s.length > 50) return null;
  if (/^\s*@/.test(s)) return null;
  // Any pipe separator means a compound page title, not a clean program name
  if (/\s\|\s/.test(s)) return null;
  if (/^join\s+/i.test(s)) return null;
  if (/\bdiscord\b.*\b(server|community|invite)\b/i.test(s)) return null;
  // Marketing copy embedded in titles
  if (/\b(FULL COURSE|FREE TRAINING|LIVE EVENT|HOSTED BY|WEBINAR|REGISTER NOW|SIGN UP NOW)\b/i.test(s)) return null;
  // Pure lowercase no-space string → just a username/handle
  if (/^[a-z][a-z0-9]{2,}$/.test(s)) return null;
  return s;
}

async function persistResult(args: {
  leadId: string;
  funnel_url: string;
  funnel_platform: string;
  program: { program_name: string | null; offer_summary: string | null; price: string | null };
  error: string | null;
}): Promise<FunnelEnrichmentResult> {
  const program_name = sanitizeProgramName(args.program.program_name);
  const sb = createAdminClient();
  await sb
    .from("leads")
    .update({
      funnel_url: args.funnel_url,
      funnel_platform: args.funnel_platform,
      funnel_program_name: program_name,
      funnel_offer_summary: args.program.offer_summary,
      funnel_price: args.program.price,
      funnel_extracted_at: new Date().toISOString(),
      funnel_extraction_error: args.error,
    })
    .eq("id", args.leadId);
  return {
    ok: !args.error,
    funnel_url: args.funnel_url,
    funnel_platform: args.funnel_platform,
    funnel_program_name: program_name,
    funnel_offer_summary: args.program.offer_summary,
    funnel_price: args.program.price,
    error: args.error,
  };
}

async function persistError(leadId: string, error: string): Promise<FunnelEnrichmentResult> {
  const sb = createAdminClient();
  await sb
    .from("leads")
    .update({
      funnel_extracted_at: new Date().toISOString(),
      funnel_extraction_error: error,
    })
    .eq("id", leadId);
  return {
    ok: false,
    funnel_url: null,
    funnel_platform: null,
    funnel_program_name: null,
    funnel_offer_summary: null,
    funnel_price: null,
    error,
  };
}
