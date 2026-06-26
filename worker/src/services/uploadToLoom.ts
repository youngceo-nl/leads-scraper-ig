import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "../config";

export type UploadToLoomResult = {
  loomUrl: string;
  embedCode: string | null;
};

// Bundled Chromium is readily fingerprinted as automated (Loom can silently
// reject a freshly-logged-in session and bounce back to /login) — a real
// Chrome channel is far less likely to be flagged. Falls back to bundled
// Chromium if Chrome isn't installed, matching lib/browser/connect.ts in the
// main app.
async function launchLoomContext(headless: boolean): Promise<BrowserContext> {
  const dir = path.resolve(config.loomSessionDir);
  try {
    return await chromium.launchPersistentContext(dir, { headless, channel: "chrome" });
  } catch {
    return chromium.launchPersistentContext(dir, { headless });
  }
}

// One-time interactive login. Opens a real (headed) browser at loom.com and
// keeps it open until you press Enter in the terminal — log in by hand
// (including any 2FA), then the persisted context at LOOM_SESSION_DIR carries
// that session into every future uploadToLoom() call. Re-run this whenever
// the session expires (uploadToLoom will throw a clear "not logged in" error).
async function login(): Promise<void> {
  const context = await launchLoomContext(false);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.loom.com/looms");
  console.log("Log into Loom in the opened browser window, then press Enter here to finish...");
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  await context.close();
  console.log(`Session saved to ${config.loomSessionDir}`);
}

async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.loom.com/looms", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Logged-out sessions get redirected to a marketing/login page.
    return !/\/(login|signin)/i.test(page.url());
  } finally {
    await page.close();
  }
}

/**
 * Uploads a rendered MP4 to Loom using the session saved by login() above,
 * and returns the share URL + embed code. Built and tested as a standalone
 * module before being wired into the job pipeline, per the project plan —
 * this is the most UI-fragile piece (depends entirely on Loom's current
 * upload/share flow), so the selectors below favor role/text-based Playwright
 * locators over CSS classes, and are the first thing to fix if Loom changes
 * its UI (see worker/README.md).
 */
export async function uploadToLoom(videoPath: string, opts: { debugScreenshotPath?: string } = {}): Promise<UploadToLoomResult> {
  const context = await launchLoomContext(true);

  try {
    if (!(await isLoggedIn(context))) {
      throw new Error(
        `uploadToLoom: not logged into Loom (session at ${config.loomSessionDir} is missing/expired). ` +
          "Run `npm run upload-to-loom:login` first.",
      );
    }

    const page = await context.newPage();
    try {
      await page.goto("https://www.loom.com/looms", { waitUntil: "domcontentloaded" });

      // The Uppy upload dashboard only mounts/becomes interactable after
      // explicitly opening it via New video -> Upload a video — these menu
      // items use role="menuitem"/"option" rather than visible role=button
      // semantics Playwright's getByRole expects, so we match on role
      // attribute + text directly and force the click past Loom's dropdown
      // open/close animation.
      await page.getByRole("button", { name: /new video/i }).first().click();
      await page
        .locator('[role="menuitem"], [role="option"]', { hasText: /upload a video/i })
        .click({ force: true, timeout: 10_000 });

      const fileInput = page.locator('input[type="file"].uppy-Dashboard-input, input[type="file"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 30_000 });
      await fileInput.setInputFiles(videoPath);

      // Uppy shows a preview + an explicit confirm button — it does not
      // auto-start the upload on file selection. Same role-vs-visibility
      // quirk as above: match by text, not getByRole.
      await page.locator("button", { hasText: /^upload \d+ files?$/i }).first().click({ timeout: 10_000 });

      // Upload + Loom-side processing can take a while for longer videos.
      await page.waitForURL(/loom\.com\/share\//, { timeout: 10 * 60_000 });
      const loomUrl = page.url();

      const embedCode = await extractEmbedCode(page);

      return { loomUrl, embedCode };
    } catch (err) {
      if (opts.debugScreenshotPath) await page.screenshot({ path: opts.debugScreenshotPath }).catch(() => {});
      throw err;
    }
  } finally {
    await context.close();
  }
}

async function extractEmbedCode(page: Page): Promise<string | null> {
  try {
    await page.getByRole("button", { name: /share/i }).first().click({ timeout: 10_000 });
    await page.getByRole("tab", { name: /embed/i }).click({ timeout: 10_000 });
    const embed = await page.locator("textarea, code").filter({ hasText: "<iframe" }).first().innerText({ timeout: 10_000 });
    return embed || null;
  } catch {
    // Per the project plan: a failed embed-code extraction must not fail the
    // whole job — the Loom URL alone is still a usable outreach asset.
    return null;
  }
}

// CLI entry: `npm run upload-to-loom:login` / `npm run upload-to-loom:test -- /path/to/video.mp4`
if (process.argv.includes("--login")) {
  await login();
} else if (process.argv.includes("--test")) {
  const videoPath = process.argv[process.argv.length - 1];
  console.log(`Uploading ${videoPath} to Loom...`);
  console.log(await uploadToLoom(videoPath));
}
