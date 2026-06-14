"use client";
import { useMemo, useState, useTransition } from "react";
import { Trash2, Play, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSeed, deleteSeed, startCrawl, updateSeedLimit, type ScrapeProvider } from "@/app/actions/seeds";
import type { Seed } from "@/lib/types";

type LatestJob = {
  id: string;
  seed_id: string;
  status: string;
  error_message: string | null;
  created_at: string;
};

export function SeedManager({
  seeds,
  jobs,
  defaultLimit,
}: {
  seeds: Seed[];
  jobs: LatestJob[];
  defaultLimit: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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
      else if ("already_existed" in res && res.already_existed) setInfo("Account was already added — moved to top.");
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
          placeholder={`How many to check (default ${defaultLimit})`}
          className="w-56"
        />
        <Button type="submit" disabled={pending}>Add account</Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-muted-foreground">{info}</p>}

      <div className="rounded-md border divide-y">
        {seeds.length === 0 && <p className="p-4 text-sm text-muted-foreground">No source accounts yet. Add one above to get started.</p>}
        {seeds.map((s) => (
          <SeedRow
            key={s.id}
            seed={s}
            defaultLimit={defaultLimit}
            latestJob={latestBySeed.get(s.id) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

const PROVIDER_OPTIONS: { value: ScrapeProvider; label: string }[] = [
  { value: "auto",        label: "Auto (best available)" },
  { value: "cookie",      label: "Cookie only (free)" },
  { value: "proxy",       label: "Cookie + IP rotation" },
  { value: "apify",       label: "Apify" },
  { value: "scrapingbee", label: "ScrapingBee" },
];

function SeedRow({
  seed,
  defaultLimit,
  latestJob,
}: {
  seed: Seed;
  defaultLimit: number;
  latestJob: LatestJob | null;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [provider, setProvider] = useState<ScrapeProvider>("auto");
  const [limit, setLimit] = useState<string>(
    seed.max_profiles_to_scrape != null ? String(seed.max_profiles_to_scrape) : "",
  );

  const limitChanged =
    (limit === "" ? null : Number(limit)) !==
    (seed.max_profiles_to_scrape ?? null);

  const lastError =
    latestJob && latestJob.status === "failed" && latestJob.error_message
      ? latestJob.error_message
      : null;

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
            <AlertCircle className="h-3 w-3 shrink-0" /> Last search failed: {lastError}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder={`default ${defaultLimit}`}
          className="w-40 h-8 text-xs"
          aria-label="How many accounts to check"
        />
        {limitChanged && (
          <Button
            size="icon"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const n = limit === "" ? null : Number(limit);
                const res = await updateSeedLimit(seed.id, n);
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

      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await startCrawl(seed.id, provider);
            setMsg("error" in res && res.error ? `Error: ${res.error}` : `Search started (${provider}).`);
          })
        }
      >
        <Play className="h-3 w-3 mr-1" /> {pending ? "Starting…" : "Start search"}
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
