import "server-only";

// Routes Instagram API calls through a real Chrome browser via Playwright.
// This gives us Chrome's actual TLS fingerprint and HTTP/2 stack, making
// requests indistinguishable from a logged-in user in a real browser.
//
// Usage: drop-in replacement for raw fetch() calls against Instagram.
// The caller provides cookies as a string; we inject them into the browser
// context before making the request.

export type BrowserFetchResult = {
  status: number;
  body: string;
};

// Chrome-only UAs — must stay consistent with web session cookies.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

// Common desktop resolutions — avoids the telltale Chromium default 1280×720
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

export function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

function parseProxyUrl(url: string): { server: string; username?: string; password?: string } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const proxy: { server: string; username?: string; password?: string } = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return { server: url };
  }
}

// Parse a "name=value; name2=value2" cookie string into Playwright cookie objects.
function parseCookies(cookieStr: string, domain = ".instagram.com") {
  return cookieStr
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      return {
        name: p.slice(0, eq).trim(),
        value: p.slice(eq + 1).trim(),
        domain,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      };
    });
}

export async function browserFetch(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cookie: string;
    proxyUrl?: string | null;
    timeoutMs?: number;
  },
): Promise<BrowserFetchResult> {
  const { chromium } = await import("playwright");

  const launchOpts: Parameters<typeof chromium.launch>[0] = { headless: true };
  if (opts.proxyUrl) launchOpts.proxy = parseProxyUrl(opts.proxyUrl);

  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({
      userAgent: randomUA(),
      viewport: randomViewport(),
      locale: "en-US",
    });
    await context.addCookies(parseCookies(opts.cookie));

    // Use Playwright's APIRequestContext — Chrome TLS fingerprint, no CORS restriction,
    // cookies from context are automatically included.
    const resp = await context.request.fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers ?? {},
      data: opts.body,
      timeout: opts.timeoutMs ?? 15000,
      failOnStatusCode: false,
    });

    return { status: resp.status(), body: await resp.text() };
  } finally {
    await browser.close();
  }
}

// Lightweight wrapper that keeps one browser alive for the duration of
// a paginated scrape session (following list, etc.). Caller must call .close().
export class BrowserSession {
  private browser: import("playwright").Browser | null = null;
  private page: import("playwright").Page | null = null;

  async init(cookie: string, proxyUrl?: string | null) {
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({
      headless: true,
      ...(proxyUrl ? { proxy: parseProxyUrl(proxyUrl) } : {}),
    });
    const context = await this.browser.newContext({
      userAgent: randomUA(),
      viewport: randomViewport(),
      locale: "en-US",
    });
    await context.addCookies(parseCookies(cookie));
    this.page = await context.newPage();
  }

  async fetch(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<BrowserFetchResult> {
    if (!this.page) throw new Error("BrowserSession not initialised — call init() first");
    // Use APIRequestContext instead of page.evaluate(() => fetch()) — no CORS restriction,
    // Chrome TLS fingerprint, and cookies from the context are automatically included.
    const resp = await this.page.context().request.fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers ?? {},
      data: opts.body,
      timeout: opts.timeoutMs ?? 15000,
      failOnStatusCode: false,
    });
    return { status: resp.status(), body: await resp.text() };
  }

  async close() {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }
}
