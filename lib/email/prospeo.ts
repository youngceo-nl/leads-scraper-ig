export type ProspeoResult =
  | { email: string }
  | { email: null; reason: string };

// Prospeo migrated from api.prospeo.io/email-finder → api.prospeo.io/enrich-person.
// New format wraps all person fields in a `data` object; response is at person.email.email.

const ENDPOINT = "https://api.prospeo.io/enrich-person";

function parseResponse(body: ProspeoEnrichResponse): ProspeoResult {
  if (body.error) {
    const code = typeof body.error_code === "string" ? body.error_code.toLowerCase() : "";
    if (code.includes("rate_limit") || code.includes("rate limit")) return { email: null, reason: "rate_limited" };
    if (code === "no_match" || code === "not_found") return { email: null, reason: "no_email_found" };
    if (code.includes("quota") || code.includes("credit") || code.includes("limit")) return { email: null, reason: "quota_exceeded" };
    if (code.includes("qualify") || code.includes("multi-account") || code.includes("upgrade")) return { email: null, reason: "invalid_api_key" };
    return { email: null, reason: code || "api_error" };
  }
  const emailStatus = body.person?.email?.status ?? "";
  const email = body.person?.email?.email ?? null;
  if (!email || emailStatus === "UNAVAILABLE") return { email: null, reason: "no_email_found" };
  return { email };
}

type ProspeoEnrichResponse = {
  error: boolean | string;
  error_code?: string;
  person?: {
    email?: {
      status?: string;
      email?: string | null;
    };
  };
};

export async function findEmailWithProspeoLinkedin(opts: {
  apiKey: string;
  linkedinUrl: string;
}): Promise<ProspeoResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KEY": opts.apiKey },
      body: JSON.stringify({ data: { linkedin_url: opts.linkedinUrl } }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 401 || res.status === 403) return { email: null, reason: "invalid_api_key" };
    if (res.status === 429) return { email: null, reason: "rate_limited" };
    if (!res.ok) return { email: null, reason: `http_${res.status}` };
    return parseResponse(await res.json() as ProspeoEnrichResponse);
  } catch (err) {
    return { email: null, reason: err instanceof Error ? err.message.slice(0, 60) : "fetch_error" };
  }
}

export async function findEmailWithProspeo(opts: {
  apiKey: string;
  domain: string;
  fullName: string | null | undefined;
}): Promise<ProspeoResult> {
  const parts = (opts.fullName ?? "")
    .split(/[|·•—–]/)[0]
    .trim()
    .split(/\s+/)
    .filter((t) => /^[a-zA-Z'-]{2,}$/.test(t));

  if (parts.length < 2) {
    return { email: null, reason: "need_first_and_last_name" };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KEY": opts.apiKey },
      body: JSON.stringify({
        data: {
          first_name: parts[0],
          last_name: parts[parts.length - 1],
          company_website: opts.domain,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) return { email: null, reason: "invalid_api_key" };
    if (res.status === 429) return { email: null, reason: "rate_limited" };
    if (!res.ok) return { email: null, reason: `http_${res.status}` };
    return parseResponse(await res.json() as ProspeoEnrichResponse);
  } catch (err) {
    return { email: null, reason: err instanceof Error ? err.message.slice(0, 60) : "fetch_error" };
  }
}
