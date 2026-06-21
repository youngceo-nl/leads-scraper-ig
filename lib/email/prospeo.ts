export type ProspeoResult =
  | { email: string }
  | { email: null; reason: string };

// https://prospeo.io — POST /email-finder
// Auth: X-KEY: {key}
// Body: { first_name, last_name, domain }
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
    const res = await fetch("https://api.prospeo.io/email-finder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KEY": opts.apiKey,
      },
      body: JSON.stringify({
        first_name: parts[0],
        last_name: parts[parts.length - 1],
        domain: opts.domain,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401 || res.status === 403) return { email: null, reason: "invalid_api_key" };
    if (res.status === 429) return { email: null, reason: "rate_limited" };
    if (!res.ok) return { email: null, reason: `http_${res.status}` };

    const body = await res.json() as {
      error: boolean;
      message?: string;
      response?: { email?: string | null };
    };

    if (body.error) return { email: null, reason: body.message ?? "api_error" };
    const email = body.response?.email ?? null;
    if (!email) return { email: null, reason: "no_email_found" };

    return { email };
  } catch (err) {
    return { email: null, reason: err instanceof Error ? err.message.slice(0, 60) : "fetch_error" };
  }
}
