export type FindymailResult =
  | { email: string; score: number }
  | { email: null; reason: string };

// https://app.findymail.com — POST /api/search/name
// Auth: Authorization: Bearer {key}
// Body: { name: "Full Name", domain: "example.com" }
export async function findEmailWithFindymail(opts: {
  apiKey: string;
  domain: string;
  fullName: string | null | undefined;
}): Promise<FindymailResult> {
  const name = (opts.fullName ?? "").split(/[|·•—–]/)[0].trim();
  if (name.split(/\s+/).filter(Boolean).length < 2) {
    return { email: null, reason: "need_first_and_last_name" };
  }

  try {
    const res = await fetch("https://app.findymail.com/api/search/name", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ name, domain: opts.domain }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401) return { email: null, reason: "invalid_api_key" };
    if (res.status === 429) return { email: null, reason: "rate_limited" };
    if (res.status === 422) return { email: null, reason: "no_email_found" };
    if (!res.ok) return { email: null, reason: `http_${res.status}` };

    const body = await res.json() as {
      email?: string | null;
      score?: number;
      emails?: Array<{ email: string; score: number }>;
    };

    // API returns either a top-level email or an emails array — handle both
    const email = body.email ?? body.emails?.[0]?.email ?? null;
    const score = body.score ?? body.emails?.[0]?.score ?? 0;
    if (!email) return { email: null, reason: "no_email_found" };

    return { email, score };
  } catch (err) {
    return { email: null, reason: err instanceof Error ? err.message.slice(0, 60) : "fetch_error" };
  }
}
