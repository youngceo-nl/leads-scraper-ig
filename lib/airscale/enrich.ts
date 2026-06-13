import "server-only";
import { airscalePost, AirscaleError } from "./client";
import { logApiUsage } from "@/lib/usage/log-usage";
import { AIRSCALE_LOOKUP_USD } from "@/lib/usage/token-pricing";

// Domains that are link aggregators / bio-link tools. They never represent the
// lead's actual company, so passing them to /v1/email is wasted credits.
const LINK_AGGREGATOR_DOMAINS = new Set([
  "linktr.ee", "linktree.com",
  "beacons.ai", "beacons.page",
  "bio.link", "lnk.bio", "linkin.bio",
  "stan.store",
  "snipfeed.co",
  "tap.bio",
  "shor.by",
  "linkpop.com",
  "campsite.bio", "campsite.to",
  "milkshake.app",
  "later.com",
  "msha.ke",
]);

export type EnrichmentInputs = {
  first_name: string | null;
  last_name: string | null;
  domain: string | null;
  skip_reason?:
    | "missing_full_name"
    | "missing_external_link"
    | "link_aggregator"
    | "invalid_url";
};

export function deriveInputs(opts: {
  full_name: string | null;
  external_link: string | null;
}): EnrichmentInputs {
  const { full_name, external_link } = opts;

  if (!full_name || !full_name.trim()) {
    return { first_name: null, last_name: null, domain: null, skip_reason: "missing_full_name" };
  }
  const tokens = full_name
    .trim()
    .replace(/[|·•@()\[\]{}]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Single-word names are no longer skipped: keep the lone token as the first
  // name (last stays null) and still attempt a domain-based lookup.
  const first = tokens[0] ?? null;
  const last = tokens.length >= 2 ? tokens[tokens.length - 1] : null;

  if (!external_link || !external_link.trim()) {
    return { first_name: first, last_name: last, domain: null, skip_reason: "missing_external_link" };
  }
  const domain = parseDomain(external_link);
  if (!domain) {
    return { first_name: first, last_name: last, domain: null, skip_reason: "invalid_url" };
  }
  if (LINK_AGGREGATOR_DOMAINS.has(domain)) {
    return { first_name: first, last_name: last, domain: null, skip_reason: "link_aggregator" };
  }
  return { first_name: first, last_name: last, domain };
}

function parseDomain(raw: string): string | null {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || !host.includes(".")) return null;
  return host;
}

export type AirscaleEmailResponse = {
  status?: string;
  email?: string | null;
  email_status?: string | null;
  provider?: string | null;
  verifier?: string | null;
  // AirScale sometimes nests under `response`
  response?: {
    email?: string | null;
    email_status?: string | null;
    provider?: string | null;
    verifier?: string | null;
  };
};

export type EnrichmentResult = {
  email: string | null;
  email_status: string;
  email_provider: string | null;
  email_verifier: string | null;
  error: string | null;
};

export async function findEmail(opts: {
  apiKey: string;
  inputs: EnrichmentInputs;
  leadId?: string | null;
}): Promise<EnrichmentResult> {
  const { apiKey, inputs } = opts;

  if (inputs.skip_reason) {
    return {
      email: null,
      email_status: `skipped:${inputs.skip_reason}`,
      email_provider: null,
      email_verifier: null,
      error: null,
    };
  }
  // Last name is optional (single-name leads); first name + domain is enough to attempt.
  if (!inputs.first_name || !inputs.domain) {
    return {
      email: null,
      email_status: "skipped:incomplete_inputs",
      email_provider: null,
      email_verifier: null,
      error: null,
    };
  }

  try {
    const body: Record<string, string> = {
      first_name: inputs.first_name,
      domain: inputs.domain,
    };
    if (inputs.last_name) body.last_name = inputs.last_name;
    const json = await airscalePost<AirscaleEmailResponse>({
      apiKey,
      path: "/email",
      body,
    });
    await logApiUsage({
      provider: "airscale",
      operation: "email_lookup",
      leadId: opts.leadId ?? null,
      quantity: 1,
      costUsd: AIRSCALE_LOOKUP_USD,
      estimated: true,
    });
    const inner = json.response ?? json;
    const email = inner.email ?? null;
    const status = inner.email_status ?? (email ? "found" : "not_found");
    return {
      email,
      email_status: status,
      email_provider: inner.provider ?? null,
      email_verifier: inner.verifier ?? null,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof AirscaleError ? err.message : (err as Error).message;
    return {
      email: null,
      email_status: "error",
      email_provider: null,
      email_verifier: null,
      error: msg,
    };
  }
}

export async function findEmailByLinkedInUrl(opts: {
  apiKey: string;
  linkedinUrl: string;
  firstName?: string | null;
  lastName?: string | null;
  leadId?: string | null;
}): Promise<EnrichmentResult> {
  try {
    const body: Record<string, string> = { linkedin_profile_url: opts.linkedinUrl };
    if (opts.firstName) body.first_name = opts.firstName;
    if (opts.lastName) body.last_name = opts.lastName;
    const json = await airscalePost<AirscaleEmailResponse>({
      apiKey: opts.apiKey,
      path: "/email",
      body,
    });
    await logApiUsage({
      provider: "airscale",
      operation: "email_lookup_linkedin",
      leadId: opts.leadId ?? null,
      quantity: 1,
      costUsd: AIRSCALE_LOOKUP_USD,
      estimated: true,
    });
    const inner = json.response ?? json;
    const email = inner.email ?? null;
    const status = inner.email_status ?? (email ? "found" : "not_found");
    return {
      email,
      email_status: status,
      email_provider: inner.provider ?? null,
      email_verifier: inner.verifier ?? null,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof AirscaleError ? err.message : (err as Error).message;
    return {
      email: null,
      email_status: "error",
      email_provider: null,
      email_verifier: null,
      error: msg,
    };
  }
}
