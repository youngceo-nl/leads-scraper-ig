import "server-only";

// Thin client for Serper.dev's Google Search API. Returns structured JSON
// (`organic` results) instead of scraped HTML — cheaper and far more robust than
// running Google through a proxy. https://serper.dev/
const SERPER_URL = "https://google.serper.dev/search";

export class SerperError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
    this.name = "SerperError";
  }
}

export type SerperOrganic = {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
};

export async function serperSearch(opts: {
  apiKey: string;
  query: string;
  num?: number;
  gl?: string; // country, e.g. "us"
  retries?: number;
}): Promise<{ organic: SerperOrganic[] }> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(SERPER_URL, {
        method: "POST",
        headers: { "X-API-KEY": opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: opts.query, num: opts.num ?? 10, gl: opts.gl ?? "us", hl: "en" }),
      });
      const text = await res.text();
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new SerperError(`Serper ${res.status}: ${text.slice(0, 200)}`, res.status, text);
      }
      let json: { organic?: SerperOrganic[] };
      try {
        json = JSON.parse(text);
      } catch {
        throw new SerperError(`Serper returned non-JSON: ${text.slice(0, 200)}`, res.status, text);
      }
      return { organic: Array.isArray(json.organic) ? json.organic : [] };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new SerperError("Serper call failed");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
