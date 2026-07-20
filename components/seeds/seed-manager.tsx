"use client";
import { useMemo, useState, useTransition } from "react";
import { Trash2, Play, Check, AlertCircle, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSeed, deleteSeed, startCrawl, startAllCrawls, updateSeedLimit, type ScrapeProvider } from "@/app/actions/seeds";
import type { Seed } from "@/lib/types";
import { SystemStatus, type SystemStatusProps } from "@/components/ui/system-status";

function friendlyCookieError(msg: string) {
  const l = msg.toLowerCase();
  if (l.includes("rate-limited") || l.includes("rate limited"))
    return "Instagram rate-limited your cookie — wait a few hours or switch to Apify.";
  if (l.includes("rejected") || l.includes("401") || l.includes("403"))
    return "Instagram blocked this burner account — remove it in Settings and add a fresh cookie.";
  return `Last search failed: ${msg}`;
}

const RATE_LIMIT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — matches cookie-pool.ts

type LatestJob = {
  id: string;
  seed_id: string;
  status: string;
  error_message: string | null;
  finished_at: string | null;
  created_at: string;
};

export function SeedManager({
  seeds,
  exhaustedSeeds = [],
  jobs,
  defaultLimit,
  systemStatus,
  scrapedSeedIds = [],
}: {
  seeds: Seed[];
  exhaustedSeeds?: Seed[];
  jobs: LatestJob[];
  defaultLimit: number;
  systemStatus: SystemStatusProps;
  /** Seeds with a completed crawl — blocked from scraping again. */
  scrapedSeedIds?: string[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [bulkProvider, setBulkProvider] = useState<ScrapeProvider>("apify");
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [addFull, setAddFull] = useState(false);

  const scraped = useMemo(() => new Set(scrapedSeedIds), [scrapedSeedIds]);

  const latestBySeed = useMemo(() => {
    const m = new Map<string, LatestJob>();
    for (const j of jobs) if (!m.has(j.seed_id)) m.set(j.seed_id, j);
    return m;
  }, [jobs]);

  const onAdd = (formData: FormData) => {
    setError(null);
    setInfo(null);
    start(async () => {
      const res = await addSeed(formData);
      if ("error" in res && res.error) setError(res.error);
      else {
        // The checkbox is controlled, so the form's own reset won't clear it.
        setAddFull(false);
        if ("already_existed" in res && res.already_existed) setInfo("Account was already added — moved to top.");
      }
    });
  };

  return (
    <div className="space-y-4">
      <form action={onAdd} className="flex gap-2">
        <Input
          name="input"
          placeholder="https://www.instagram.com/username/  or  username"
          required
          className="flex-1"
        />
        <Input
          name="max_profiles_to_scrape"
          type="number"
          min={1}
          disabled={addFull}
          placeholder={addFull ? "all following" : `How many to check (default ${defaultLimit})`}
          className="w-56"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            name="scrape_full_following"
            checked={addFull}
            onChange={(e) => setAddFull(e.target.checked)}
            className="h-4 w-4"
          />
          Full account
        </label>
        <Button type="submit" disabled={pending}>Add account</Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-muted-foreground">{info}</p>}

      {seeds.length > 0 && (
        <div className="space-y-2">
          <SystemStatus {...systemStatus} />
        </div>
      )}

      {seeds.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={bulkProvider}
            onChange={(e) => setBulkProvider(e.target.value as ScrapeProvider)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await startAllCrawls(bulkProvider);
                setBulkMsg(`Started ${res.started} crawl${res.started !== 1 ? "s" : ""}.`);
              })
            }
          >
            <ChevronsRight className="h-3.5 w-3.5 mr-1.5" />
            Crawl all
          </Button>
          {bulkMsg && <span className="text-xs text-muted-foreground">{bulkMsg}</span>}
        </div>
      )}

      <div className="rounded-md border divide-y">
        {seeds.length === 0 && <p className="p-4 text-sm text-muted-foreground">No source accounts yet. Add one above to get started.</p>}
        {seeds.map((s) => (
          <SeedRow
            key={s.id}
            seed={s}
            defaultLimit={defaultLimit}
            latestJob={latestBySeed.get(s.id) ?? null}
            scraped={scraped.has(s.id)}
          />
        ))}
      </div>

      {exhaustedSeeds.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {exhaustedSeeds.length} seed{exhaustedSeeds.length !== 1 ? "s" : ""} exhausted and hidden from auto-scrape:{" "}
          {exhaustedSeeds.map((s) => `@${s.username}`).join(", ")}
        </p>
      )}
    </div>
  );
}

// ScrapingBee is gone: it has no code path in scrape-following.ts, and
// offering it meant picking a provider that silently ran something else.
const PROVIDER_OPTIONS: { value: ScrapeProvider; label: string }[] = [
  { value: "apify",      label: "Apify (standard)" },
  { value: "auto",       label: "Auto (Apify → Playwright → cookie)" },
  { value: "playwright", label: "Playwright" },
  { value: "cookie",     label: "Cookie only (free, max ~250)" },
];

function SeedRow({
  seed,
  defaultLimit,
  latestJob,
  scraped,
}: {
  seed: Seed;
  defaultLimit: number;
  latestJob: LatestJob | null;
  /** Has a completed crawl — re-scraping needs the override password. */
  scraped: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [provider, setProvider] = useState<ScrapeProvider>("apify");
  const [overriding, setOverriding] = useState(false);
  const [password, setPassword] = useState("");
  const [limit, setLimit] = useState<string>(
    seed.max_profiles_to_scrape != null ? String(seed.max_profiles_to_scrape) : "",
  );
  const [full, setFull] = useState<boolean>(seed.scrape_full_following ?? false);

  const limitChanged =
    full !== (seed.scrape_full_following ?? false) ||
    (!full &&
      (limit === "" ? null : Number(limit)) !== (seed.max_profiles_to_scrape ?? null));

  const rawError =
    latestJob && latestJob.status === "failed" && latestJob.error_message
      ? latestJob.error_message
      : null;
  const errorAge = latestJob?.finished_at ? Date.now() - new Date(latestJob.finished_at).getTime() : 0;
  const isRateLimit = rawError ? rawError.toLowerCase().includes("rate-limited") || rawError.toLowerCase().includes("rate limited") : false;
  const lastError = isRateLimit && errorAge > RATE_LIMIT_TTL_MS ? null : rawError;

  return (
    <div className="flex items-center gap-3 p-3">
      <div className="flex-1 min-w-0">
        <a href={seed.profile_url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
          @{seed.username}
        </a>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        {!msg && seed.exhausted_providers.includes("cookie") && (provider === "cookie" || provider === "auto") && (
          <p className="text-xs text-amber-600 flex items-center gap-1">
            <AlertCircle className="h-3 w-3 shrink-0" />
            Cookie exhausted — switch to Apify to get more accounts.
          </p>
        )}
        {lastError && !msg && (
          <p className="text-xs text-destructive flex items-center gap-1 truncate" title={lastError}>
            <AlertCircle className="h-3 w-3 shrink-0" />
            {friendlyCookieError(lastError)}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          value={full ? "" : limit}
          disabled={full}
          onChange={(e) => setLimit(e.target.value)}
          placeholder={full ? "all following" : `default ${defaultLimit}`}
          className="w-40 h-8 text-xs"
          aria-label="How many accounts to check"
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Full
        </label>
        {limitChanged && (
          <Button
            size="icon"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const n = limit === "" ? null : Number(limit);
                const res = await updateSeedLimit(seed.id, n, full);
                setMsg("error" in res && res.error ? `Error: ${res.error}` : "Saved.");
              })
            }
            aria-label="Save followings limit"
            title="Save"
          >
            <Check className="h-4 w-4" />
          </Button>
        )}
      </div>

      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as ScrapeProvider)}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
        aria-label="Scrape method"
      >
        {PROVIDER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {scraped && !overriding && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setOverriding(true)}
          title="This account has already been scraped"
        >
          Scrape again
        </Button>
      )}
      {/* Keyed off `overriding` alone, not `scraped`: when a crawl finishes
          after this page rendered, `scraped` is still false and gating on it
          would hide the very field the error tells you to fill in. */}
      {overriding && (
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Override password"
          className="w-40 h-8 text-xs"
          autoFocus
          aria-label="Re-scrape override password"
        />
      )}

      <Button
        size="sm"
        variant="secondary"
        // An already-scraped account only becomes startable once the override
        // input is showing — the password is checked server-side regardless.
        disabled={pending || (scraped && !overriding)}
        title={scraped && !overriding ? "Already scraped" : undefined}
        onClick={() =>
          start(async () => {
            // Persist an unsaved Full/limit change before starting, so the
            // crawl matches what the row is showing. Without this, ticking
            // Full and hitting start silently ran the *stored* config — the
            // scrape wasn't full and nothing said so.
            if (limitChanged) {
              const saved = await updateSeedLimit(seed.id, limit === "" ? null : Number(limit), full);
              if ("error" in saved && saved.error) {
                setMsg(`Error saving settings: ${saved.error}`);
                return;
              }
            }
            const res = await startCrawl(seed.id, provider, overriding ? password : undefined);
            if ("error" in res && res.error) {
              setMsg(`Error: ${res.error}`);
              // The seed finished a crawl after this page rendered, so the row
              // is still showing the un-scraped controls. Reveal the password
              // field instead of asking for a password with nowhere to type it.
              if ("needs_override" in res && res.needs_override) setOverriding(true);
            } else if ("ok" in res && res.ok) {
              setMsg(
                `Search started — ${provider}, ${full ? "full account" : `up to ${limit || defaultLimit}`}.`,
              );
              setOverriding(false);
              setPassword("");
              window.dispatchEvent(new CustomEvent("open-activity-drawer", {
                detail: {
                  label: `Scraping @${res.seed_username}`,
                  // 0 in full mode: the crawl runs until the following list
                  // ends, so profile_limit is just the fallback default and
                  // showing it as a target ("0 / 1000") is meaningless.
                  total: res.full_account ? 0 : res.profile_limit,
                  type: "crawl",
                  startedAt: Date.now(),
                  crawl_job_id: res.crawl_job_id,
                },
              }));
            }
          })
        }
      >
        <Play className="h-3 w-3 mr-1" />
        {pending ? "Starting…" : scraped || overriding ? "Scrape again" : "Start search"}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        disabled={pending}
        onClick={() => start(() => deleteSeed(seed.id))}
        aria-label="Remove source account"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
