import type { Browser, BrowserContext } from "playwright";

// Mirrors lib/browser/connect.ts in the main app (same BROWSER_WS_ENDPOINT
// convention) but kept as a standalone copy — this package deliberately
// doesn't depend on the Next.js app's lib/, see project plan.
export async function connectBrowser(opts: {
  headless?: boolean;
  contextOptions?: Parameters<Browser["newContext"]>[0];
} = {}): Promise<{ browser: Browser; context: BrowserContext; isRemote: boolean }> {
  const { chromium } = await import("playwright");
  const endpoint = process.env.BROWSER_WS_ENDPOINT;

  if (endpoint) {
    const browser = await chromium.connectOverCDP(endpoint);
    const existing = browser.contexts()[0];
    const context = existing ?? (await browser.newContext(opts.contextOptions));
    return { browser, context, isRemote: true };
  }

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext(opts.contextOptions);
  return { browser, context, isRemote: false };
}
