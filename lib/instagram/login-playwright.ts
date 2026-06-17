import { generateTotp } from "@/lib/totp";
import type { CheckpointState } from "@/lib/types";

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; checkpoint: true; state: CheckpointState; message: string }
  | { ok: false; checkpoint?: false; error: string };

export async function loginInstagramPlaywright(creds: {
  username: string;
  password: string;
  totp_secret?: string | null;
  capsolver_api_key?: string | null;
}): Promise<LoginResult> {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // Step 1: GET homepage for initial cookies + CSRF token
  let homeRes: Response;
  try {
    homeRes = await fetch("https://www.instagram.com/", {
      headers: { "User-Agent": ua, "Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
    });
  } catch (err) {
    return { ok: false, error: `Network error reaching Instagram: ${err instanceof Error ? err.message : String(err)}` };
  }

  const cookieMap = parseCookies(homeRes.headers.getSetCookie?.() ?? []);
  const csrf = cookieMap.get("csrftoken");
  if (!csrf) return { ok: false, error: "Could not get CSRF token from Instagram — check network connectivity" };

  const timestamp = Math.floor(Date.now() / 1000);
  const encPassword = `#PWD_INSTAGRAM_BROWSER:0:${timestamp}:${creds.password}`;

  const baseHeaders = (extra: Record<string, string> = {}) => ({
    "User-Agent": ua,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-CSRFToken": cookieMap.get("csrftoken") ?? csrf,
    "X-IG-App-ID": "936619743392459",
    "X-Instagram-AJAX": "1",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.instagram.com/",
    "Cookie": cookieStr(cookieMap),
    ...extra,
  });

  // Step 2: POST login
  const loginRes = await fetch("https://www.instagram.com/api/v1/web/accounts/login/ajax/", {
    method: "POST",
    headers: baseHeaders(),
    body: new URLSearchParams({ username: creds.username, enc_password: encPassword, queryParams: "{}", optIntoOneTap: "false" }).toString(),
  });

  mergeCookies(cookieMap, loginRes.headers.getSetCookie?.() ?? []);

  // Instagram sometimes redirects the login POST to a challenge page (HTML) instead
  // of returning JSON — detect this by checking the final URL after redirect-follow.
  const finalUrl = loginRes.url ?? "";
  const isRedirectedToChallenge = finalUrl.includes("/challenge/") || finalUrl.includes("/checkpoint/");

  let json: Record<string, unknown>;
  try {
    json = await loginRes.json();
  } catch {
    if (isRedirectedToChallenge) {
      return handleCheckpoint(finalUrl, cookieMap, csrf, baseHeaders);
    }
    console.error("[ig-login] non-JSON response", loginRes.status, finalUrl);
    return { ok: false, error: `Instagram returned non-JSON (status ${loginRes.status})` };
  }

  // Also handle the case where JSON was returned at a challenge URL
  if (isRedirectedToChallenge && !json.authenticated) {
    return handleCheckpoint(finalUrl, cookieMap, csrf, baseHeaders);
  }

  // 2FA
  if (json.two_factor_required) {
    if (!creds.totp_secret) return { ok: false, error: "Instagram requires 2FA but no TOTP secret is configured" };
    const tfInfo = (json.two_factor_info ?? {}) as Record<string, string>;
    const totp = generateTotp(creds.totp_secret);
    const tfRes = await fetch("https://www.instagram.com/api/v1/web/accounts/login/ajax/two_factor/", {
      method: "POST",
      headers: baseHeaders(),
      body: new URLSearchParams({ username: creds.username, verificationCode: totp, identifier: tfInfo.two_factor_identifier ?? "", queryParams: "{}", trustThisDevice: "0", verificationMethod: "3" }).toString(),
    });
    mergeCookies(cookieMap, tfRes.headers.getSetCookie?.() ?? []);
    let tfJson: Record<string, unknown> = {};
    try { tfJson = await tfRes.json(); } catch { /* ignore */ }
    if (!tfJson.authenticated) return { ok: false, error: "2FA verification failed — check your TOTP secret" };
    return buildCookieResult(cookieMap);
  }

  // Checkpoint (phone/email verification)
  if (json.message === "checkpoint_required" || json.checkpoint_url) {
    console.error("[ig-login] checkpoint_required full json:", JSON.stringify(json));
    const emailFromLogin = extractEmail(json);
    const checkpointPath = (json.checkpoint_url as string) ?? "";
    const challengeUrl = checkpointPath.startsWith("http") ? checkpointPath : `https://www.instagram.com${checkpointPath}`;
    return handleCheckpoint(challengeUrl, cookieMap, csrf, baseHeaders, emailFromLogin, creds.capsolver_api_key ?? null);
  }

  if (!json.authenticated) {
    const msg = typeof json.message === "string" ? json.message : JSON.stringify(json);
    return { ok: false, error: `Login rejected by Instagram: ${msg}` };
  }

  return buildCookieResult(cookieMap);
}

export async function submitInstagramCheckpointCode(
  state: CheckpointState,
  code: string,
): Promise<LoginResult> {
  // The /auth_platform/ flow is a React SPA that can't be driven by plain fetch —
  // use Playwright to navigate back to the challenge page (CAPTCHA already passed,
  // so it shows the code entry form) and submit the code via the UI.
  if (state.challenge_url.includes("/auth_platform/")) {
    const { submitAuthPlatformCode } = await import("@/lib/instagram/captcha");
    return submitAuthPlatformCode(state.challenge_url, state.cookies, state.csrf, code);
  }

  // Legacy /challenge/ flow — plain fetch works here.
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const cookieMap = new Map<string, string>();

  for (const part of state.cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1) cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }

  const headers = {
    "User-Agent": ua,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-CSRFToken": state.csrf,
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": state.challenge_url,
    "Cookie": state.cookies,
  };

  const res = await fetch(state.challenge_url, {
    method: "POST",
    headers,
    body: new URLSearchParams({ security_code: code.trim() }).toString(),
  });

  mergeCookies(cookieMap, res.headers.getSetCookie?.() ?? []);

  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* might redirect */ }

  if (json.status === "ok" || cookieMap.has("sessionid")) {
    return buildCookieResult(cookieMap);
  }

  return { ok: false, error: `Invalid code: ${typeof json.message === "string" ? json.message : "try again"}` };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function handleCheckpoint(
  challengeUrl: string,
  cookieMap: Map<string, string>,
  csrf: string,
  baseHeaders: (extra?: Record<string, string>) => Record<string, string>,
  seedEmail: string | null = null,
  capsolverApiKey: string | null = null,
): Promise<LoginResult> {
  let emailHint: string | null = seedEmail;

  // ── /auth_platform/ flow: requires CAPTCHA bypass via CapSolver ──────────
  if (challengeUrl.includes("/auth_platform/") && capsolverApiKey) {
    console.error("[ig-login] /auth_platform/ checkpoint detected — attempting CapSolver bypass");
    const { bypassInstagramCaptcha } = await import("@/lib/instagram/captcha");
    const updatedCookies = await bypassInstagramCaptcha(challengeUrl, cookieStr(cookieMap), capsolverApiKey);
    if (updatedCookies) {
      // Merge updated cookies back into our map
      for (const part of updatedCookies.split(";")) {
        const eq = part.indexOf("=");
        if (eq !== -1) cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
      console.error("[ig-login] CapSolver bypass succeeded — email should be sent");
    } else {
      console.error("[ig-login] CapSolver bypass failed — user must solve CAPTCHA manually or retry");
    }

    return {
      ok: false,
      checkpoint: true,
      state: {
        cookies: cookieStr(cookieMap),
        csrf: cookieMap.get("csrftoken") ?? csrf,
        challenge_url: challengeUrl,
        email_hint: emailHint,
      },
      message: updatedCookies
        ? "Instagram sent a verification code to the account email. Enter it below to complete login."
        : "Instagram requires CAPTCHA verification. CapSolver bypass failed — try refreshing again or check your CapSolver API key.",
    };
  }

  // ── Legacy /challenge/ flow: plain fetch works ────────────────────────────

  // GET the challenge page — Instagram may return JSON with step_data.contact_point or HTML with masked email
  try {
    const challengeRes = await fetch(challengeUrl, { headers: baseHeaders() });
    mergeCookies(cookieMap, challengeRes.headers.getSetCookie?.() ?? []);
    const body = await challengeRes.text();
    try {
      emailHint = extractEmail(JSON.parse(body) as Record<string, unknown>);
    } catch { /* HTML */ }
    if (!emailHint) emailHint = extractEmailFromHtml(body);
    console.error("[ig-login] challenge GET body (first 500):", body.slice(0, 500));
  } catch { /* best-effort */ }

  // POST choice=1 to trigger email verification; response often contains contact point
  try {
    const choiceRes = await fetch(challengeUrl, {
      method: "POST",
      headers: baseHeaders({ "Referer": challengeUrl }),
      body: new URLSearchParams({ choice: "1" }).toString(),
    });
    mergeCookies(cookieMap, choiceRes.headers.getSetCookie?.() ?? []);
    console.error("[ig-login] triggered email choice, status", choiceRes.status);
    const choiceBody = await choiceRes.text();
    console.error("[ig-login] choice POST body (first 500):", choiceBody.slice(0, 500));
    try {
      emailHint = extractEmail(JSON.parse(choiceBody) as Record<string, unknown>) ?? emailHint;
    } catch { /* HTML */ }
    if (!emailHint) emailHint = extractEmailFromHtml(choiceBody) ?? emailHint;
  } catch (e) {
    console.error("[ig-login] email choice POST failed", e);
  }

  console.error("[ig-login] email_hint:", emailHint);
  return {
    ok: false,
    checkpoint: true,
    state: { cookies: cookieStr(cookieMap), csrf: cookieMap.get("csrftoken") ?? csrf, challenge_url: challengeUrl, email_hint: emailHint },
    message: "Instagram sent a verification code to the account email. Enter it below to complete login.",
  };
}

function extractEmail(json: Record<string, unknown>): string | null {
  // Instagram returns contact info in various shapes depending on the challenge type
  const step = json.step_data as Record<string, unknown> | undefined;
  if (typeof step?.contact_point === "string") return step.contact_point;
  if (typeof step?.email === "string") return step.email;
  if (typeof json.contact_point === "string") return json.contact_point as string;
  if (typeof json.email === "string") return json.email as string;
  // Some flows nest it under challenge_type_enum_map
  const nested = json.challenge_type_enum_map as Record<string, unknown> | undefined;
  if (nested) {
    for (const v of Object.values(nested)) {
      const r = v as Record<string, unknown> | undefined;
      if (typeof r?.contact_point === "string") return r.contact_point;
    }
  }
  return null;
}

function extractEmailFromHtml(html: string): string | null {
  // Matches masked emails like n****@gmail.com or ab***@yahoo.co.uk
  const m = html.match(/[a-zA-Z0-9._%+*-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

function parseCookies(raw: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const header of raw) {
    const [pair] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq !== -1) m.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return m;
}

function mergeCookies(map: Map<string, string>, raw: string[]) {
  for (const [k, v] of parseCookies(raw)) map.set(k, v);
}

function cookieStr(map: Map<string, string>): string {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

const AUTH = new Set(["sessionid", "csrftoken", "ds_user_id", "ig_did", "mid", "ig_nrcb", "rur"]);

function buildCookieResult(map: Map<string, string>): LoginResult {
  if (!map.has("sessionid")) return { ok: false, error: "Login succeeded but no sessionid cookie returned" };
  const cookie = [...map.entries()].filter(([k]) => AUTH.has(k)).map(([k, v]) => `${k}=${v}`).join("; ");
  return { ok: true, cookie };
}
