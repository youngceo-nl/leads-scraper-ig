// One place to get a Chromium browser + context, whether it runs locally or on
// a remote/hosted browser. Set BROWSER_WS_ENDPOINT to a CDP WebSocket URL to
// run off your machine — e.g. a self-hosted browserless container
//   ws://YOUR_HOST:3000?token=YOUR_TOKEN
// or a Browserbase / Browserless cloud connect URL. When it's unset we launch
// Chromium locally (dev / worker with a browser installed).
//
// Set YT_BROWSER_PROFILE_PATH to a directory created by login-automation.mjs
// to reuse a persistent Chrome session — this avoids Google's Device-Bound
// Session Credentials (DBSC) check that causes HTTP 500 when injected cookies
// are used in a fresh browser process.
//
// Playwright is imported dynamically so it never lands in the serverless bundle.

import type { Browser, BrowserContext } from "playwright";

export type ConnectResult = { browser: Browser; context: BrowserContext; isRemote: boolean };

export async function connectBrowser(opts: {
  headless?: boolean;
  proxy?: string | null; // local-launch only; for remote, configure the proxy on the provider
  args?: string[]; // extra Chromium launch flags (local-launch only)
  channel?: string; // prefer a real browser channel (e.g. "chrome"); falls back to bundled Chromium
  contextOptions?: Parameters<Browser["newContext"]>[0];
  profilePath?: string; // reuse a persistent Chrome profile (avoids DBSC cookie-injection failures)
}): Promise<ConnectResult> {
  const { chromium } = await import("playwright");
  const endpoint = process.env.BROWSER_WS_ENDPOINT;

  if (endpoint) {
    const browser = await chromium.connectOverCDP(endpoint);
    // Hosted providers (e.g. Browserbase) hand back a pre-configured context;
    // plain browserless starts empty, so create one with our options.
    const existing = browser.contexts()[0];
    const context = existing ?? (await browser.newContext(opts.contextOptions as never));
    return { browser, context, isRemote: true };
  }

  const proxyOpts = opts.proxy ? { proxy: { server: opts.proxy } } : {};
  const baseArgs = opts.args ?? [];

  // Persistent profile mode: Chrome owns the DBSC device keys so the session
  // transfers seamlessly — no cookie injection needed. launchPersistentContext
  // returns the BrowserContext directly; browser() is always non-null for local.
  if (opts.profilePath) {
    const context = await chromium.launchPersistentContext(opts.profilePath, {
      headless: opts.headless ?? true,
      channel: opts.channel as string | undefined,
      args: baseArgs,
      ...proxyOpts,
      ...(opts.contextOptions ?? {}),
    });
    return { browser: context.browser()!, context, isRemote: false };
  }

  const launchOpts = {
    headless: opts.headless ?? true,
    ...proxyOpts,
    ...(baseArgs.length ? { args: baseArgs } : {}),
  };
  // A real browser channel (Chrome) is far less likely to be served logged-out /
  // bot-blocked than bundled Chromium. Fall back to Chromium if it isn't installed.
  let browser;
  if (opts.channel) {
    try {
      browser = await chromium.launch({ ...launchOpts, channel: opts.channel });
    } catch {
      browser = await chromium.launch(launchOpts);
    }
  } else {
    browser = await chromium.launch(launchOpts);
  }
  const context = await browser.newContext(opts.contextOptions as never);
  return { browser, context, isRemote: false };
}
