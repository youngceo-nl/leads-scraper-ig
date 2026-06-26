import { connectBrowser } from "../utils/browser";

export type RecordProspectPageInput = {
  url: string;
  outputPath: string;
  /** Saved (best-effort) on failure for diagnosing what the page looked like. */
  debugScreenshotPath?: string;
};

/**
 * MVP "screen recording": a homepage screenshot, which Remotion then pans/
 * zooms (see remotion/src/components/ScreenRecording.tsx). The source spec
 * itself flags this as more reliable than a live scroll recording — a real
 * Playwright video capture is a stretch goal, not required for the MVP.
 */
export async function recordProspectPage(input: RecordProspectPageInput): Promise<string> {
  const { browser, context } = await connectBrowser({
    headless: true,
    contextOptions: { viewport: { width: 1440, height: 900 } },
  });

  try {
    const page = await context.newPage();
    try {
      await page.goto(input.url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() =>
        // Some sites never go fully idle (analytics polling, websockets) —
        // a DOM-ready load is good enough for a static screenshot.
        page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 }),
      );
      await page.screenshot({ path: input.outputPath });
      return input.outputPath;
    } catch (err) {
      if (input.debugScreenshotPath) await page.screenshot({ path: input.debugScreenshotPath }).catch(() => {});
      throw err;
    }
  } finally {
    await context.close();
    await browser.close();
  }
}
