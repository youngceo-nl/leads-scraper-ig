import "server-only";

const APIFY_BASE = "https://api.apify.com/v2";

export class ApifyError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
    this.name = "ApifyError";
  }
}

type RunActorOptions = {
  token: string | string[];
  actorId: string;
  input: unknown;
  timeoutSecs?: number;
  memoryMbytes?: number;
  retries?: number;
};

// Start an actor run and poll until it finishes, then return dataset items.
// Accepts multiple tokens; rotates to the next when one hits its usage limit.
export async function runActorAsync<T = unknown>(opts: RunActorOptions): Promise<T[]> {
  const tokens = Array.isArray(opts.token) ? opts.token : [opts.token];
  const { actorId, input, timeoutSecs = 600, memoryMbytes = 1024 } = opts;

  let lastErr: unknown;
  for (const token of tokens) {
    try {
      return await _runActorAsync<T>({ token, actorId, input, timeoutSecs, memoryMbytes });
    } catch (err) {
      lastErr = err;
      if (err instanceof ApifyError && err.status === 403) {
        const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "");
        if (body.includes("platform-feature-disabled") || body.includes("usage") || body.includes("limit")) {
          continue; // try next token
        }
      }
      throw err; // non-limit error — don't rotate
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApifyError("All Apify tokens exhausted");
}

async function _runActorAsync<T>(opts: { token: string; actorId: string; input: unknown; timeoutSecs: number; memoryMbytes: number }): Promise<T[]> {
  const { token, actorId, input, timeoutSecs, memoryMbytes } = opts;

  // 1. Start the run
  const startUrl = `${APIFY_BASE}/acts/${actorId}/runs?token=${token}&timeout=${timeoutSecs}&memory=${memoryMbytes}`;
  const startRes = await fetch(startUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new ApifyError(`Apify ${actorId} start failed: ${startRes.status}`, startRes.status, text);
  }
  const startData = (await startRes.json()) as { data: { id: string; defaultDatasetId: string; status: string } };
  const { id: runId, defaultDatasetId } = startData.data;

  // 2. Poll until terminal state
  const POLL_INTERVAL_MS = 8_000;
  const HARD_DEADLINE_MS = (timeoutSecs + 60) * 1000; // actor timeout + 60s buffer
  const start = Date.now();

  while (Date.now() - start < HARD_DEADLINE_MS) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${APIFY_BASE}/acts/${actorId}/runs/${runId}?token=${token}`);
    if (!pollRes.ok) break;
    const { data } = (await pollRes.json()) as { data: { status: string } };
    if (data.status === "SUCCEEDED") break;
    if (data.status === "FAILED" || data.status === "ABORTED" || data.status === "TIMED-OUT") {
      throw new ApifyError(`Apify ${actorId} run ${data.status.toLowerCase()}`, undefined, { runId });
    }
  }

  // 3. Fetch dataset items
  const itemsRes = await fetch(
    `${APIFY_BASE}/datasets/${defaultDatasetId}/items?token=${token}&format=json&clean=true`,
  );
  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => "");
    throw new ApifyError(`Apify dataset fetch failed: ${itemsRes.status}`, itemsRes.status, text);
  }
  return (await itemsRes.json()) as T[];
}

// Legacy sync path — kept for small actor calls where latency matters and
// batches are small enough to complete within 300s.
export async function runActorSync<T = unknown>(opts: RunActorOptions): Promise<T[]> {
  const {
    token,
    actorId,
    input,
    timeoutSecs = 120,   // stay well under Apify's 300s hard limit
    memoryMbytes = 1024,
    retries = 2,
  } = opts;

  const url = new URL(`${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items`);
  url.searchParams.set("token", Array.isArray(token) ? token[0] : token);
  url.searchParams.set("timeout", String(Math.min(timeoutSecs, 280))); // cap at 280s to avoid 403
  url.searchParams.set("memory", String(memoryMbytes));
  url.searchParams.set("format", "json");

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ApifyError(`Apify ${actorId} failed: ${res.status}`, res.status, text);
      }
      const body = await res.json();
      // 201 = run started but sync timed out — body is run metadata, not items
      if (res.status === 201 || !Array.isArray(body)) {
        throw new ApifyError(`Apify ${actorId} sync timed out (201) — use runActorAsync for large batches`, 201);
      }
      return body as T[];
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApifyError("Apify call failed");
}

function backoffMs(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
