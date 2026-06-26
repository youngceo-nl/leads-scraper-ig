import { connectBrowser } from "@/lib/browser/connect";
import { generateTotp } from "@/lib/totp";
import type { AppSettings } from "@/lib/types";

// Auto-refreshes the logged-in Google cookie used to read/reveal YouTube
// business emails. When the current YT_GOOGLE_COOKIE goes stale, this drives a
// headless Chromium through Google's sign-in flow (email → password → TOTP
// 2-Step), then harvests the freshly-minted google.com / youtube.com cookies.
//
// ⚠️ FRAGILITY: scripting Google's password login is the single most hostile
// target for browser automation. It WILL intermittently fail on:
//   • "This browser or app may not be secure" (automation detection)
//   • "Verify it's you" device/location challenges (esp. from datacenter IPs)
//   • phone/email 2-Step prompts we can't satisfy programmatically
//   • CAPTCHA on the login form
// To maximise the success rate, use a DEDICATED Google account whose only 2FA
// is an authenticator app (so YT_GOOGLE_TOTP_SECRET can answer it), and route
// the browser through a residential proxy that matches where you first logged
// in (YT_REVEAL_PROXY). Even then, expect to occasionally re-seed by hand.
//
// Playwright is reached via connectBrowser, which imports it dynamically so it
// never lands in the serverless bundle. Requires a runtime that can run
// Chromium (local/worker) or a remote browser via BROWSER_WS_ENDPOINT.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Cookie names that actually authenticate a youtube.com / google.com session.
// We harvest everything on those domains but keep the header lean by skipping
// obvious non-auth analytics cookies.
const SKIP_COOKIE_PREFIXES = ["_ga", "_gid", "OTZ", "NID", "AEC", "DV", "1P_JAR"];

export type RefreshResult = {
  cookie: string | null;
  error: string | null;
};

export type LoginCreds = {
  email: string;
  password: string;
  totpSecret?: string | null; // base32 authenticator secret, optional
};

// Credentials live in the DB (app_settings) first so they're always available
// in production, with env vars as a local-dev fallback.
type SettingsCreds = Pick<AppSettings, "yt_google_email" | "yt_google_password" | "yt_google_totp_secret">;

export function youtubeLoginConfigured(settings?: Partial<SettingsCreds>): boolean {
  const email = settings?.yt_google_email || process.env.YT_GOOGLE_EMAIL;
  const password = settings?.yt_google_password || process.env.YT_GOOGLE_PASSWORD;
  return Boolean(email && password);
}

// "live"   — the cookie authenticates a signed-in YouTube session
// "dead"   — the cookie is missing / logged-out / rejected (re-mint needed)
// "unknown"— couldn't tell (network blip, consent wall); don't force a re-login
export type CookieLiveness = "live" | "dead" | "unknown";

// Cheap liveness probe used to decide — BEFORE the expensive captcha reveal —
// whether the stored cookie is still good or must be re-minted via login.
// A signed-in YouTube homepage embeds `"LOGGED_IN":true` in its bootstrap config
// (ytcfg); a logged-out one embeds `false`. Plain HTTP GET, no browser/captcha.
export async function checkYoutubeCookieLive(cookie: string | null | undefined): Promise<CookieLiveness> {
  if (!cookie || !cookie.trim()) return "dead";
  try {
    const res = await fetch("https://www.youtube.com/", {
      headers: {
        Cookie: cookie,
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401 || res.status === 403) return "dead";
    if (!res.ok) return "unknown";
    const html = await res.text();
    if (/"(?:LOGGED_IN|logged_in|loggedIn)"\s*:\s*true/.test(html)) return "live";
    if (/"(?:LOGGED_IN|logged_in|loggedIn)"\s*:\s*false/.test(html)) return "dead";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function resolveCreds(settings?: Partial<SettingsCreds>): LoginCreds | null {
  const email = settings?.yt_google_email || process.env.YT_GOOGLE_EMAIL || "";
  const password = settings?.yt_google_password || process.env.YT_GOOGLE_PASSWORD || "";
  if (!email || !password) return null;
  return { email, password, totpSecret: settings?.yt_google_totp_secret || process.env.YT_GOOGLE_TOTP_SECRET || null };
}

// ── Concurrency guard ──────────────────────────────────────────────────────
// Many leads can hit a dead cookie at once. Collapse concurrent refreshes onto
// one in-flight login, and enforce a cooldown so a failed login isn't retried
// in a tight loop (which would get the account flagged faster). NOTE: this is
// per-process state — across multiple serverless instances it won't dedupe, so
// run the enrichment worker as a single instance for this to bite.
let inFlight: Promise<RefreshResult> | null = null;
let lastAttemptAt = 0;
let lastResult: RefreshResult | null = null;
const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Logs in with the env-configured Google account, saves the fresh cookie to
 * app_settings.yt_google_cookie, and returns it. De-duplicates concurrent
 * callers and rate-limits retries via a cooldown.
 */
export async function refreshAndSaveYoutubeCookie(): Promise<RefreshResult> {
  if (inFlight) return inFlight;

  const since = Date.now() - lastAttemptAt;
  if (lastResult && since < COOLDOWN_MS) {
    // Within cooldown: hand back the last outcome instead of hammering Google.
    if (lastResult.cookie) return lastResult;
    return { cookie: null, error: `cooldown (last attempt ${Math.round(since / 1000)}s ago): ${lastResult.error}` };
  }

  inFlight = (async (): Promise<RefreshResult> => {
    // Use the service-role client directly (not the server-only settings
    // module) so this also runs from a plain `tsx` CLI. Credentials come from
    // the DB first (always available in prod), env vars as a local fallback.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const sb = createAdminClient();
    const { data: settings } = await sb.from("app_settings").select("*").eq("id", 1).single();
    const creds = resolveCreds((settings as Partial<SettingsCreds>) ?? undefined);
    if (!creds) return { cookie: null, error: "YouTube login not configured (set credentials in Settings or env)" };
    try {
      const cookie = await loginAndExtractCookie(creds, {
        proxy: process.env.YT_REVEAL_PROXY || null,
        headless: process.env.HEADLESS !== "false",
      });
      await sb.from("app_settings").update({ yt_google_cookie: cookie }).eq("id", 1);
      const result: RefreshResult = { cookie, error: null };
      lastResult = result;
      return result;
    } catch (err) {
      const result: RefreshResult = { cookie: null, error: err instanceof Error ? err.message : String(err) };
      lastResult = result;
      return result;
    } finally {
      lastAttemptAt = Date.now();
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Low-level: drive Chromium through Google sign-in and return the Cookie header
 * for a logged-in youtube.com session. Throws with a human-readable reason when
 * Google blocks the automated login.
 */
export async function loginAndExtractCookie(
  creds: LoginCreds,
  opts: { proxy?: string | null; headless?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const { proxy = null, headless = true, timeoutMs = 30_000 } = opts;

  const { browser, context } = await launchLoginBrowser({ headless, proxy });

  try {
    // Stealth: blunt the signals behind Google's "this browser may not be
    // secure" block. Runs before any page script.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // Some checks look for window.chrome.runtime.
      (window as unknown as { chrome?: unknown }).chrome ??= { runtime: {} };
    });
    const page = await context.newPage();

    await page.goto("https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    // ── Email ──
    const emailInput = page.locator('input[name="identifier"], #identifierId, input[type="email"]').first();
    await emailInput.waitFor({ state: "visible", timeout: timeoutMs });
    await emailInput.fill(creds.email);
    await clickNext(page, timeoutMs);
    await detectBlock(page, "after email");

    // ── Account picker ──
    // Google shows a "Choose an account" list when the browser has seen this
    // account before. Click the matching entry so we reach the password step.
    await maybeHandleAccountPicker(page, creds.email);

    // ── Password ──
    // Race: wait for the password field OR a recognisable blocker page.
    // If neither appears within the timeout, throw with the current URL so the
    // user knows what Google actually showed instead of a raw Playwright log.
    const pwInput = page.locator('input[name="Passwd"], input[type="password"]:not([aria-hidden="true"])').first();
    const pwVisible = await pwInput.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true).catch(() => false);
    if (!pwVisible) {
      const url = page.url();
      const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "").catch(() => "")) as string;
      throw new Error(`Google did not show the password field — it may require a phone/SMS verification or showed a challenge we can't pass automatically. Current page: ${url.slice(0, 100)}${body ? ` — "${body.replace(/\s+/g, " ").slice(0, 150)}"` : ""}`);
    }
    await pwInput.fill(creds.password);
    await clickNext(page, timeoutMs);
    await page.waitForTimeout(2500);
    await detectBlock(page, "after password");

    // Google frequently interrupts a fresh login with "add 2-Step Verification",
    // "add a recovery phone/email", or "protect your account" upsells. These are
    // skippable — dismiss them rather than treating them as a real challenge.
    await dismissInterstitials(page);

    // ── 2-Step Verification (real authenticator-code prompt only) ──
    await maybeAnswerTotp(page, creds.totpSecret ?? null, timeoutMs);
    await dismissInterstitials(page);

    // Land on YouTube so the youtube.com cookies are set, then harvest.
    await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(1500);

    const cookies = await context.cookies(["https://www.youtube.com", "https://accounts.google.com", "https://www.google.com"]);
    const header = buildCookieHeader(cookies);

    // Sanity-check: a real logged-in session carries the SID-family cookies.
    if (!/(^|;\s*)SID=/.test(header) && !/__Secure-1PSID=/.test(header)) {
      const url = page.url();
      throw new Error(`login did not produce a signed-in session (ended at ${url.slice(0, 120)}) — likely a challenge we can't pass`);
    }
    return header;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Launches a browser tuned to survive Google's automation detection. Prefers
// the user's real Chrome (channel:"chrome") over bundled Chromium — the single
// biggest factor in getting past "this browser may not be secure" — and only
// falls back to Chromium if Chrome isn't installed. Honors BROWSER_WS_ENDPOINT
// for a remote browser (where stealth must be configured on the provider).
async function launchLoginBrowser(opts: { headless: boolean; proxy: string | null }) {
  if (process.env.BROWSER_WS_ENDPOINT) {
    const { browser, context } = await connectBrowser({
      headless: opts.headless,
      proxy: opts.proxy,
      contextOptions: { userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } },
    });
    return { browser, context };
  }

  const { chromium } = await import("playwright");
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const base = { headless: opts.headless, args, ...(opts.proxy ? { proxy: { server: opts.proxy } } : {}) };

  let browser;
  try {
    browser = await chromium.launch({ ...base, channel: "chrome" }); // real Chrome
  } catch {
    browser = await chromium.launch(base); // bundled Chromium fallback
  }
  const context = await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } });
  return { browser, context };
}

async function clickNext(page: import("playwright").Page, timeoutMs: number): Promise<void> {
  const next = page
    .locator("#identifierNext button, #passwordNext button")
    .or(page.getByRole("button", { name: /next/i }))
    .first();
  if ((await next.count()) > 0) {
    await next.click({ timeout: timeoutMs }).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }
}

// Detect the common dead-ends and fail fast with a clear reason instead of
// hanging until the step timeout.
// Handles Google's "Choose an account" picker that appears when the browser
// has seen the account before. Clicks the matching email entry so the flow
// continues to the password step as normal.
async function maybeHandleAccountPicker(page: import("playwright").Page, email: string): Promise<void> {
  // Wait briefly for either the password field or the account picker to appear.
  const picker = page.locator(`[data-email="${email}"], [data-identifier="${email}"]`).first();
  const pickerVisible = await picker.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
  if (pickerVisible) {
    await picker.click().catch(() => {});
    await page.waitForTimeout(1500);
    return;
  }
  // Fallback: look for an "Use another account" link and any list item containing the email text
  const useAnother = page.getByRole("link", { name: /use another account/i }).or(page.getByRole("button", { name: /use another account/i })).first();
  if ((await useAnother.count()) > 0) {
    await useAnother.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function detectBlock(page: import("playwright").Page, where: string): Promise<void> {
  const body = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string;
  const patterns: Array<[RegExp, string]> = [
    [/couldn.?t (sign|find) you in|wrong password|incorrect/i, "credentials rejected"],
    [/this browser or app may not be secure/i, "Google blocked the automated browser ('browser may not be secure')"],
    [/verify it.?s you/i, "Google demanded an identity challenge ('Verify it's you')"],
    [/unusual activity|try again later|temporarily/i, "Google rate-limited / flagged the login"],
    [/recaptcha|i.?m not a robot/i, "Google served a CAPTCHA on login"],
  ];
  for (const [re, msg] of patterns) {
    if (re.test(body)) throw new Error(`${msg} (${where})`);
  }
}

// Clicks past skippable post-login upsells ("add 2-Step", "add recovery
// phone/email", "protect your account"). Loops because Google often chains
// several. Does nothing when no such prompt is present.
async function dismissInterstitials(page: import("playwright").Page, rounds = 4): Promise<void> {
  const skipLabel = /not now|no thanks|skip|cancel|remind me later|confirm later|do this later|maybe later/i;
  for (let i = 0; i < rounds; i++) {
    const skip = page
      .getByRole("button", { name: skipLabel })
      .or(page.getByRole("link", { name: skipLabel }))
      .first();
    if ((await skip.count()) === 0) return;
    await skip.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

// Only fires on a genuine authenticator-code entry (#totpPin) — NOT on the
// "add a recovery phone" screen (which also has a tel input). Most accounts
// won't hit this at all; it's here for accounts that do enforce app-based 2FA.
async function maybeAnswerTotp(page: import("playwright").Page, totpSecret: string | null, timeoutMs: number): Promise<void> {
  const totpInput = page.locator('input[name="totpPin"], #totpPin').first();
  const visible = await totpInput.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
  if (!visible) return;

  if (!totpSecret) {
    throw new Error("Google enforced authenticator 2-Step but no TOTP secret is configured (set it in Settings / YT_GOOGLE_TOTP_SECRET)");
  }
  await totpInput.fill(generateTotp(totpSecret));
  await clickNext(page, timeoutMs);
  await page.waitForTimeout(2500);
  await detectBlock(page, "after 2FA");
}

// Builds a "name=value; name=value" Cookie header from harvested cookies,
// de-duped by name and stripped of obvious analytics noise.
function buildCookieHeader(cookies: Array<{ name: string; value: string }>): string {
  const byName = new Map<string, string>();
  for (const c of cookies) {
    if (SKIP_COOKIE_PREFIXES.some((p) => c.name.startsWith(p))) continue;
    if (!byName.has(c.name)) byName.set(c.name, c.value);
  }
  return [...byName.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

/**
 * Iterates all entries in `app_settings.yt_accounts` and re-mints each cookie.
 * Called by the Inngest cron so accounts stay fresh without user interaction.
 */
export async function refreshAllYtAccounts(): Promise<{ refreshed: number; failed: number }> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();
  const { data: row } = await sb.from("app_settings").select("yt_accounts").eq("id", 1).single();
  const accounts: Array<{
    id: string; label: string; password: string; totp_secret: string | null;
    cookie: string | null; cookie_set_at: string | null; last_error: string | null; paused?: boolean;
  }> = (row as { yt_accounts?: unknown })?.yt_accounts as typeof accounts ?? [];

  if (!accounts.length) return { refreshed: 0, failed: 0 };

  let refreshed = 0;
  let failed = 0;
  const updated = [...accounts];

  for (let i = 0; i < updated.length; i++) {
    const account = updated[i];
    if (account.paused) continue;
    if (!account.password) { failed++; continue; }
    try {
      const cookie = await loginAndExtractCookie({
        email: account.label,
        password: account.password,
        totpSecret: account.totp_secret,
      });
      updated[i] = { ...account, cookie, cookie_set_at: new Date().toISOString(), last_error: null };
      refreshed++;
    } catch (err) {
      updated[i] = { ...account, last_error: err instanceof Error ? err.message : String(err) };
      failed++;
    }
  }

  await sb.from("app_settings").update({ yt_accounts: updated }).eq("id", 1);
  return { refreshed, failed };
}

