import { generateTotp } from "@/lib/totp";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const AUTH_COOKIE_NAMES = new Set([
  "sessionid", "csrftoken", "ds_user_id", "ig_did", "mid", "ig_nrcb", "rur",
]);

async function dismissAnyDialog(page: import("playwright").Page) {
  const dismissSelectors = [
    // Cookie consent (EU)
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Allow essential and optional cookies")',
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    // Generic overlays
    'button:has-text("Not Now")',
    'button:has-text("Close")',
  ];
  for (const sel of dismissSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1_500 })) {
        await btn.click();
        await page.waitForTimeout(800);
      }
    } catch { /* not present */ }
  }
}

export async function loginInstagramPlaywright(creds: {
  username: string;
  password: string;
  totp_secret?: string | null;
}): Promise<string> {
  const { chromium } = await import("playwright");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    // @ts-expect-error intentional
    window.chrome = { runtime: {} };
  });

  try {
    const page = await context.newPage();

    // Navigate and wait for the network to quiet down
    try {
      await page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
    } catch {
      // networkidle timeout is common — the page is usually ready enough
    }

    // Give JS a moment to render and dismiss any dialogs
    await page.waitForTimeout(2_000);
    await dismissAnyDialog(page);
    await page.waitForTimeout(500);

    // Confirm we're actually on the login page
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");

    // If Instagram redirected us somewhere unexpected, report it clearly
    if (!currentUrl.includes("instagram.com")) {
      throw new Error(`Unexpected redirect to: ${currentUrl.slice(0, 150)}`);
    }
    if (pageText.includes("challenge") || currentUrl.includes("/challenge/")) {
      throw new Error("Instagram requires a challenge (CAPTCHA or identity check) — log in manually in a browser first to clear it");
    }

    // Look for the username input — if it's not there, tell us what IS there
    const usernameInput = page.locator('input[name="username"]').first();
    const usernameFound = await usernameInput.waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);

    if (!usernameFound) {
      const snippet = pageText.slice(0, 300).replace(/\s+/g, " ");
      throw new Error(`Login form not found on page. URL: ${currentUrl.slice(0, 100)} | Page text: "${snippet}"`);
    }

    await usernameInput.click();
    await usernameInput.fill(creds.username);
    await page.waitForTimeout(400);

    const passwordInput = page.locator('input[name="password"]').first();
    await passwordInput.waitFor({ state: "visible", timeout: 5_000 });
    await passwordInput.click();
    await passwordInput.fill(creds.password);
    await page.waitForTimeout(400);

    // Submit
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Log In")',
      '[data-testid="royal_login_button"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2_000 })) {
          await btn.click();
          submitted = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (!submitted) await passwordInput.press("Enter");

    await page.waitForTimeout(5_000);

    // 2FA
    const totpInput = page
      .locator('input[name="verificationCode"], input[aria-label*="verification" i], input[aria-label*="code" i], input[aria-label*="security" i]')
      .first();
    const totpVisible = await totpInput.isVisible().catch(() => false);

    if (totpVisible) {
      if (!creds.totp_secret) throw new Error("Instagram requires 2FA but no TOTP secret is configured");
      await totpInput.fill(generateTotp(creds.totp_secret));
      const confirmBtn = page.locator('button[type="submit"], button:has-text("Confirm")').first();
      await confirmBtn.click();
      await page.waitForTimeout(4_000);
    }

    // Dismiss interstitials
    for (let i = 0; i < 4; i++) {
      const skip = page.getByRole("button", { name: /not now|skip|cancel|later/i }).first();
      if ((await skip.count()) === 0) break;
      await skip.click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // Detect error messages
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const blocks: Array<[RegExp, string]> = [
      [/incorrect password|wrong password/i, "Incorrect password — double-check it in Settings"],
      [/we detected an unusual login attempt/i, "Instagram flagged the login as unusual — log in manually once in a browser to clear it"],
      [/your account has been disabled/i, "This Instagram account has been disabled"],
      [/we couldn.?t log you in/i, "Instagram could not log in — check credentials"],
      [/suspicious activity/i, "Instagram detected suspicious activity — log in manually once to clear it"],
      [/challenge_required|confirm.*identity/i, "Instagram requires identity confirmation — log in manually once to clear it"],
    ];
    for (const [re, msg] of blocks) {
      if (re.test(body)) throw new Error(msg);
    }

    const finalUrl = page.url();
    if (finalUrl.includes("/accounts/login/") || finalUrl.includes("/challenge/")) {
      const snippet = body.slice(0, 200).replace(/\s+/g, " ");
      throw new Error(`Still on login/challenge page after submit. URL: ${finalUrl.slice(0, 100)} | "${snippet}"`);
    }

    const cookies = await context.cookies(["https://www.instagram.com", "https://instagram.com"]);
    if (!cookies.some((c) => c.name === "sessionid")) {
      throw new Error(`Login did not produce a sessionid cookie — ended at ${finalUrl.slice(0, 100)}`);
    }

    const auth = cookies.filter((c) => AUTH_COOKIE_NAMES.has(c.name));
    return auth.map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await browser.close().catch(() => {});
  }
}
