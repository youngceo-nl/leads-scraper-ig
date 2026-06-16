export type HunterResult =
  | { email: string; score: number; domain: string }
  | { email: null; reason: string };

export async function findEmailWithHunter(opts: {
  apiKey: string;
  domain: string;
  fullName: string | null | undefined;
}): Promise<HunterResult> {
  const name = (opts.fullName ?? "")
    .split(/[|·•—–]/)[0]
    .trim()
    .split(/\s+/)
    .filter((t) => /^[a-zA-Z'-]{2,}$/.test(t));

  if (name.length < 2) {
    return { email: null, reason: "need_first_and_last_name" };
  }

  const params = new URLSearchParams({
    domain: opts.domain,
    first_name: name[0],
    last_name: name[name.length - 1],
    api_key: opts.apiKey,
  });

  try {
    const res = await fetch(`https://api.hunter.io/v2/email-finder?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 401) return { email: null, reason: "invalid_api_key" };
    if (res.status === 429) return { email: null, reason: "rate_limited" };
    if (!res.ok) return { email: null, reason: `http_${res.status}` };

    const body = await res.json() as {
      data?: { email?: string | null; score?: number; domain?: string };
      errors?: Array<{ details: string }>;
    };

    if (body.errors?.length) return { email: null, reason: body.errors[0].details };
    const email = body.data?.email;
    const score = body.data?.score ?? 0;
    if (!email) return { email: null, reason: "no_email_found" };

    return { email, score, domain: opts.domain };
  } catch (err) {
    return { email: null, reason: err instanceof Error ? err.message.slice(0, 60) : "fetch_error" };
  }
}
