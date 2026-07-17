// Headless-Chromium automation that reveals the GATED business email behind the
// "View email address" button on a YouTube channel's About page, solving the
// reCAPTCHA Enterprise challenge with CapSolver.
//
// This is the captcha path. The free path (lib/youtube/about.ts) only reads
// emails the creator already published. Use this when the email is gated.
//
// RUNTIME: Playwright launches real Chromium, which cannot run inside the
// Next.js/Inngest *serverless* functions. It works when the pipeline runs:
//   • locally (`npm run dev`) — launches Chromium on your machine, or
//   • on a worker with Chromium installed, or
//   • against a remote browser when BROWSER_WS_ENDPOINT is set (connectOverCDP),
//     which is the only way to drive it from a serverless deployment.
//
// Playwright is imported dynamically so it is never pulled into the serverless
// bundle (and is listed in next.config serverExternalPackages).

import { solveRecaptchaEnterprise } from "../captcha/capsolver";
import { connectBrowser } from "../browser/connect";

export type RevealResult = {
  email: string | null;
  businessEmailAvailable: boolean;
  error: string | null;
};

export type RevealOpts = {
  channelUrl: string;
  googleCookie: string; // Cookie header from a logged-in youtube.com session (ignored when profilePath is set)
  capsolverKey: string;
  proxy?: string | null; // "http://user:pass@host:port"
  headless?: boolean; // default true
  timeoutMs?: number; // per-step nav timeout, default 30s
  profilePath?: string | null; // persistent Chrome profile dir — skips cookie injection, avoids DBSC 500s
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const NOISE_DOMAINS = ["youtube.com", "google.com", "gstatic.com", "googleapis.com", "schema.org"];

export async function revealYoutubeEmail(opts: RevealOpts): Promise<RevealResult> {
  const { channelUrl, googleCookie, capsolverKey, proxy = null, headless = true, timeoutMs = 30_000, profilePath = null } = opts;
  if (!channelUrl) return fail("missing channelUrl");
  if (!profilePath && !googleCookie) return fail("missing googleCookie (must be a logged-in session)");
  if (!capsolverKey) return fail("missing capsolverKey");

  const aboutUrl = channelUrl.replace(/\/+$/, "").replace(/\/about$/i, "") + "/about";

  // When a persistent profile path is configured (set via YT_BROWSER_PROFILE_PATH
  // or passed directly), reuse it to avoid Google's Device-Bound Session Credentials
  // (DBSC) check. The profile was created by login-automation.mjs using bundled
  // Chromium, so we use the same Chromium build here (no channel override).
  const { browser } = await connectBrowser({
    headless,
    proxy,
    channel: profilePath ? undefined : "chrome",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    contextOptions: { userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } },
    profilePath: profilePath ?? undefined,
  });

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } }));
    // Blunt the headless/automation signals before any page script runs — mirrors
    // the login browser, so a live session isn't downgraded to logged-out.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      (window as unknown as { chrome?: unknown }).chrome ??= { runtime: {} };
    });
    // Skip cookie injection when using a persistent profile — the session is already
    // stored natively and injecting DBSC-bound cookies would cause HTTP 500.
    if (!profilePath && googleCookie) {
      const cookieLoad = await addCookiesResilient(context, parseCookies(googleCookie));
      if (cookieLoad.skipped.length) {
        console.warn(`[yt-reveal] skipped ${cookieLoad.skipped.length} malformed cookie(s): ${cookieLoad.skipped.join(", ")}`);
      }
    }
    const page = await context.newPage();

    await page.goto(aboutUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await dismissConsent(page);

    // The About modal renders async — wait for either the reveal control or the
    // signed-out prompt before deciding, otherwise we race the empty DOM.
    const revealBtn = page
      .getByText(/view email address/i)
      .or(page.getByRole("button", { name: /view email address/i }))
      .or(page.getByRole("link", { name: /view email address/i }))
      .first();
    const signInPrompt = page.getByText(/sign in to see email address/i).first();
    await revealBtn.or(signInPrompt).waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {});

    if ((await revealBtn.count()) === 0) {
      // Distinguish "not signed in" (cookie bad/expired) from "no business email".
      const needsSignIn = await page.getByText(/sign in to see email address/i).first().count();
      if (needsSignIn > 0) {
        return { email: null, businessEmailAvailable: true, error: "not signed in — YT_GOOGLE_COOKIE is missing/expired/incomplete (need the full logged-in Cookie header)" };
      }
      return { email: null, businessEmailAvailable: false, error: "no 'View email address' button — channel has no gated business email" };
    }

    await revealBtn.scrollIntoViewIfNeeded().catch(() => {});
    await revealBtn.click({ timeout: timeoutMs });

    const frame = await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: timeoutMs }).catch(() => null);
    if (!frame) {
      const direct = await readEmail(page);
      return { email: direct, businessEmailAvailable: true, error: direct ? null : "captcha never appeared and no email found" };
    }

    const src = (await frame.getAttribute("src")) ?? "";
    const websiteKey = new URL(src).searchParams.get("k");
    const isInvisible = /size=invisible/.test(src);
    if (!websiteKey) return { email: null, businessEmailAvailable: true, error: "could not extract reCAPTCHA sitekey" };

    const token = await solveRecaptchaEnterprise({ apiKey: capsolverKey, websiteURL: aboutUrl, websiteKey, isInvisible, proxy });
    await injectToken(page, token);

    const email = await readEmail(page, timeoutMs);
    return { email, businessEmailAvailable: true, error: email ? null : "captcha solved but no email surfaced (token injection may need tuning)" };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await browser.close().catch(() => {});
  }
}

// Inject the solved token and fire reCAPTCHA's callback so the host page treats
// the challenge as passed. TUNE: if the email never surfaces, inspect
// window.___grecaptcha_cfg against live YouTube to find the real callback.
async function injectToken(page: import("playwright").Page, token: string): Promise<void> {
  await page.evaluate((tok: string) => {
    document
      .querySelectorAll('textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"]')
      .forEach((t) => { (t as HTMLTextAreaElement).value = tok; });
    try {
      const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } }).___grecaptcha_cfg;
      if (cfg?.clients) {
        const seen = new Set<unknown>();
        const findCallback = (obj: unknown, depth: number): ((t: string) => void) | null => {
          if (!obj || depth > 6 || seen.has(obj) || typeof obj !== "object") return null;
          seen.add(obj);
          for (const k of Object.keys(obj as Record<string, unknown>)) {
            const v = (obj as Record<string, unknown>)[k];
            if (k === "callback" && typeof v === "function") return v as (t: string) => void;
            if (v && typeof v === "object") {
              const f = findCallback(v, depth + 1);
              if (f) return f;
            }
          }
          return null;
        };
        for (const cid of Object.keys(cfg.clients)) {
          const cb = findCallback(cfg.clients[cid], 0);
          if (cb) { cb(tok); break; }
        }
      }
    } catch { /* best-effort */ }
  }, token);

  const confirm = page.getByRole("button", { name: /confirm|continue|submit|done/i }).first();
  if ((await confirm.count()) > 0) await confirm.click({ timeout: 5000 }).catch(() => {});
}

async function readEmail(page: import("playwright").Page, timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mailto = page.locator('a[href^="mailto:"]').first();
    if ((await mailto.count()) > 0) {
      const href = (await mailto.getAttribute("href")) ?? "";
      const addr = href.replace(/^mailto:/i, "").split("?")[0].trim();
      if (addr) return addr.toLowerCase();
    }
    const text = await page.evaluate(() => document.body.innerText || "");
    const found = (text.match(EMAIL_RE) || [])
      .map((e) => e.toLowerCase())
      .find((e) => !NOISE_DOMAINS.some((d) => e.endsWith("@" + d)));
    if (found) return found;
    await page.waitForTimeout(500);
  }
  return null;
}

async function dismissConsent(page: import("playwright").Page): Promise<void> {
  for (const name of [/accept all/i, /i agree/i, /accept the use/i]) {
    const btn = page.getByRole("button", { name }).first();
    if ((await btn.count()) > 0) { await btn.click().catch(() => {}); break; }
  }
}

type PwCookie = {
  name: string;
  value: string;
  domain?: string;
  url?: string;
  path?: string;
  secure: boolean;
  sameSite: "None" | "Lax";
};

// Chromium rejects an entire addCookies batch if any one cookie has invalid
// fields (a stale/hand-pasted YT_GOOGLE_COOKIE often carries one). Try the batch
// first, then fall back to adding cookies one at a time so the valid auth
// cookies still load and the reveal can proceed instead of dying outright.
async function addCookiesResilient(
  context: import("playwright").BrowserContext,
  cookies: PwCookie[],
): Promise<{ added: number; skipped: string[] }> {
  try {
    await context.addCookies(cookies);
    return { added: cookies.length, skipped: [] };
  } catch {
    const skipped: string[] = [];
    let added = 0;
    for (const c of cookies) {
      try {
        await context.addCookies([c]);
        added++;
      } catch {
        skipped.push(c.name);
      }
    }
    return { added, skipped };
  }
}

function parseCookies(cookieHeader: string): PwCookie[] {
  const pairs = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const i = c.indexOf("=");
      return i === -1 ? null : { name: c.slice(0, i).trim(), value: c.slice(i + 1).trim() };
    })
    .filter((x): x is { name: string; value: string } => x !== null && x.name !== "");

  const cookies: PwCookie[] = [];
  for (const { name, value } of pairs) {
    for (const host of ["www.youtube.com", "www.google.com"]) {
      if (name.startsWith("__Host-")) {
        // __Host-* cookies are INVALID with a Domain attribute — they must be
        // host-only (Secure, Path=/, no domain). Set via `url` so Playwright
        // stores them host-only; attaching a domain makes Chromium reject the
        // entire addCookies batch with "Invalid cookie fields".
        cookies.push({ name, value, url: `https://${host}/`, secure: true, sameSite: "Lax" });
      } else {
        // Everything else (SID, SAPISID, __Secure-*SID, HSID, SSID, …) is the
        // real auth set and is fine on a shared parent domain.
        cookies.push({ name, value, domain: `.${host.replace(/^www\./, "")}`, path: "/", secure: true, sameSite: "None" });
      }
    }
  }
  return cookies;
}

function fail(error: string): RevealResult {
  return { email: null, businessEmailAvailable: false, error };
}
