import type { BrowserContext, Page } from "playwright";

const IG_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── CapSolver API ─────────────────────────────────────────────────────────────

async function capsolverSolveRecaptcha(
  apiKey: string,
  pageUrl: string,
  siteKey: string,
): Promise<string | null> {
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "ReCaptchaV2TaskProxyless", websiteURL: pageUrl, websiteKey: siteKey },
    }),
  });

  const createData = (await createRes.json()) as Record<string, unknown>;
  if (createData.errorId !== 0) {
    console.error("[capsolver] createTask error:", createData.errorDescription);
    return null;
  }

  const taskId = createData.taskId as string;
  console.error("[capsolver] taskId:", taskId);

  // Poll up to 90 s (30 × 3 s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "ready") {
      const token = (data.solution as Record<string, string>)?.gRecaptchaResponse ?? null;
      console.error("[capsolver] solved, token length:", token?.length ?? 0);
      return token;
    }
    if (data.status === "failed") {
      console.error("[capsolver] task failed:", data.errorDescription);
      return null;
    }
  }

  console.error("[capsolver] timed out waiting for solution");
  return null;
}

// ── Playwright helpers ────────────────────────────────────────────────────────

function cookiesToPlaywright(cookieStr: string, domain = ".instagram.com") {
  return cookieStr
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain, path: "/" };
    });
}

async function extractSiteKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // data-sitekey on wrapper div
    const el = document.querySelector("[data-sitekey]");
    if (el) return el.getAttribute("data-sitekey");
    // sitekey in reCAPTCHA iframe src: ?k=SITEKEY
    for (const iframe of document.querySelectorAll("iframe")) {
      const m = iframe.src.match(/[?&]k=([A-Za-z0-9_-]{20,})/);
      if (m) return m[1];
    }
    return null;
  });
}

async function injectRecaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t) => {
    // Set hidden textarea value (standard reCAPTCHA)
    const ta = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement | null;
    if (ta) ta.value = t;

    // Fire the registered callback (reCAPTCHA v2 / enterprise)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = (window as any).___grecaptcha_cfg;
      if (cfg?.clients) {
        for (const key of Object.keys(cfg.clients)) {
          const client = cfg.clients[key];
          const findCb = (obj: unknown, depth = 0): ((...a: unknown[]) => void) | null => {
            if (depth > 6 || !obj || typeof obj !== "object") return null;
            for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
              if (k === "callback" && typeof v === "function") return v as (...a: unknown[]) => void;
              const found = findCb(v, depth + 1);
              if (found) return found;
            }
            return null;
          };
          const cb = findCb(client);
          if (cb) { cb(t); return; }
        }
      }
    } catch { /* ignore */ }

    // Fallback: click the submit button
    const btn = document.querySelector<HTMLElement>("button[type=submit], input[type=submit]");
    if (btn) btn.click();
  }, token);
}

// ── Public: CAPTCHA bypass during login ──────────────────────────────────────

/**
 * Uses Playwright to navigate Instagram's /auth_platform/recaptcha/ challenge,
 * solves it with CapSolver, waits for the email code input form, and returns
 * the updated cookies (with the recaptcha-passed session state embedded).
 *
 * Returns updated cookieStr on success, null on any failure.
 */
export async function bypassInstagramCaptcha(
  challengeUrl: string,
  cookieStr: string,
  capsolverApiKey: string,
): Promise<string | null> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context: BrowserContext = await browser.newContext({ userAgent: IG_UA });
    await context.addCookies(cookiesToPlaywright(cookieStr));
    const page = await context.newPage();

    console.error("[ig-captcha] navigating to:", challengeUrl);
    // Use "load" so the JS bundle has a chance to execute before we inspect the DOM
    await page.goto(challengeUrl, { waitUntil: "load", timeout: 25000 });

    // The SPA navigates internally to /recaptcha/ — wait for that URL change
    await page.waitForURL(/\/recaptcha\//, { timeout: 15000 }).catch(() => {});

    const currentUrl = page.url();
    console.error("[ig-captcha] landed on:", currentUrl);

    // Now wait for the reCAPTCHA iframe or data-sitekey div to appear in the DOM
    const recaptchaPresent = await page
      .waitForSelector('iframe[src*="recaptcha"], [data-sitekey]', { timeout: 25000 })
      .catch(() => null);

    if (!recaptchaPresent) {
      console.error("[ig-captcha] recaptcha widget never appeared, page:", (await page.content()).slice(0, 800));
      return null;
    }

    let siteKey = await extractSiteKey(page);

    if (!siteKey) {
      console.error("[ig-captcha] no sitekey after widget appeared, html snippet:", (await page.content()).slice(0, 800));
      return null;
    }

    console.error("[ig-captcha] sitekey:", siteKey);

    const token = await capsolverSolveRecaptcha(capsolverApiKey, currentUrl, siteKey);
    if (!token) return null;

    await injectRecaptchaToken(page, token);

    // Wait for the recaptcha page to go away (Instagram sends the email and changes state)
    await page
      .waitForFunction(() => !window.location.href.includes("/recaptcha/"), { timeout: 20000 })
      .catch(() => {});

    console.error("[ig-captcha] post-captcha url:", page.url());

    // Collect updated cookies
    const cookies = await context.cookies("https://www.instagram.com");
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (err) {
    console.error("[ig-captcha] error:", err);
    return null;
  } finally {
    await browser.close();
  }
}

// ── Public: code submission for /auth_platform/ flow ─────────────────────────

/**
 * For the /auth_platform/ flow, uses Playwright to navigate back to the challenge
 * page (which now shows the code entry form because CAPTCHA was already solved),
 * enters the verification code, submits, and extracts the session cookie.
 */
export async function submitAuthPlatformCode(
  challengeUrl: string,
  cookies: string,
  csrf: string,
  code: string,
): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: IG_UA });
    await context.addCookies(cookiesToPlaywright(cookies));
    const page = await context.newPage();

    console.error("[ig-captcha] submit code: navigating to", challengeUrl);
    await page.goto(challengeUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Wait for any code input field
    const codeInput = await page
      .waitForSelector(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="verificationCode"], input[type="tel"], input[maxlength="6"]',
        { timeout: 15000 },
      )
      .catch(() => null);

    if (!codeInput) {
      // Maybe already logged in?
      const pageCookies = await context.cookies("https://www.instagram.com");
      const sessionid = pageCookies.find((c) => c.name === "sessionid");
      if (sessionid) {
        const AUTH = new Set(["sessionid", "csrftoken", "ds_user_id", "ig_did", "mid", "ig_nrcb", "rur"]);
        const cookie = pageCookies.filter((c) => AUTH.has(c.name)).map((c) => `${c.name}=${c.value}`).join("; ");
        return { ok: true, cookie };
      }
      return { ok: false, error: "Could not find code input field on Instagram challenge page" };
    }

    await codeInput.fill(code.trim());

    // Look for submit button
    const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await codeInput.press("Enter");
    }

    // Wait for navigation (logged in) or error
    await Promise.race([
      page.waitForURL(/instagram\.com(?!\/(auth_platform|challenge|checkpoint))/, { timeout: 15000 }),
      page.waitForSelector('[role="alert"], [aria-live="assertive"]', { timeout: 15000 }),
    ]).catch(() => {});

    // Check cookies for sessionid
    const finalCookies = await context.cookies("https://www.instagram.com");
    const sessionCookie = finalCookies.find((c) => c.name === "sessionid");

    if (sessionCookie) {
      const AUTH = new Set(["sessionid", "csrftoken", "ds_user_id", "ig_did", "mid", "ig_nrcb", "rur"]);
      const cookie = finalCookies.filter((c) => AUTH.has(c.name)).map((c) => `${c.name}=${c.value}`).join("; ");
      return { ok: true, cookie };
    }

    // Try to extract error text from page
    const errorText = await page
      .evaluate(() => {
        const el = document.querySelector('[role="alert"], [aria-live="assertive"]');
        return el?.textContent?.trim() ?? null;
      })
      .catch(() => null);

    return { ok: false, error: errorText ?? "Verification failed — check the code and try again" };
  } catch (err) {
    return { ok: false, error: `Playwright error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await browser.close();
  }
}
