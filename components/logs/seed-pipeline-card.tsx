"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Play } from "lucide-react";
import {
  getSeedPipelines,
  type ScrapeRun,
  type SeedFunnel,
  type SeedPipeline,
} from "@/app/actions/crawl-jobs";
import { triggerSeedBackfill, triggerSeedFilter, triggerSeedVerify } from "@/app/actions/leads";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const POLL_MS = 4000;
const IDLE_POLL_MS = 15000;

type ActionKind = "backfill" | "filter" | "verify";

const ACTION_LABELS: Record<ActionKind, string> = {
  backfill: "Backfill",
  filter: "Filter",
  verify: "AI Verify",
};

type Stage = { label: string; n: number | null };

/** `n: null` renders as "—" — genuinely not measured, distinct from a real 0. */
function StageList({ stages }: { stages: Stage[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
      {stages.map((s) => (
        <span key={s.label} className="text-muted-foreground">
          <span
            className={s.n == null ? "text-muted-foreground" : "font-medium text-foreground"}
            title={s.n == null ? "Not measured — predates per-stage tracking" : undefined}
          >
            {s.n == null ? "—" : s.n.toLocaleString()}
          </span>{" "}
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** One run's own counters — kept per-run in the expanded history below the card. */
function runStages(run: ScrapeRun): Stage[] {
  return [
    { label: "found", n: run.found },
    { label: "backfilled", n: run.legacy ? null : run.backfilled },
    { label: "filtered", n: run.legacy ? null : run.filtered },
    { label: "AI verified", n: run.legacy ? null : run.verified },
  ];
}

/**
 * The seed's whole pipeline, computed from current lead state rather than one
 * run — the card's headline row. This is what removes the dash for good: a
 * pre-counter run can never report its own backfilled/filtered/verified
 * numbers, but the *current* state of its leads is always knowable.
 */
function seedStages(f: SeedFunnel): Stage[] {
  return [
    { label: "following", n: f.found },
    { label: "scraped", n: f.scraped },
    { label: "duplicates removed", n: f.duplicates },
    { label: "excluded", n: f.excluded },
    { label: "new", n: f.new },
    { label: "backfilled", n: f.backfilled },
    { label: "rejected", n: f.rejected },
    { label: "filtered", n: f.filtered },
    { label: "AI verified", n: f.verified },
  ];
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "queued")
    return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />;
  if (status === "failed") return <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  if (status === "cancelled")
    return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
}

function SeedCard({ seed, onChanged }: { seed: SeedPipeline; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<ActionKind>("backfill");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  // Selecting an action never runs it — Start is the only thing that does,
  // kept as its own button rather than a menu item so choosing ≠ doing.
  const pendingCount: Record<ActionKind, number> = {
    backfill: seed.needsBackfill,
    filter: seed.needsFilter,
    verify: seed.needsVerify,
  };
  const count = pendingCount[action];
  // Nothing left for this action — the button goes inert rather than
  // queueing an empty job.
  const done = count === 0;

  const runAction = () =>
    start(async () => {
      setMsg(null);
      if (action === "backfill") {
        const res = await triggerSeedBackfill(seed.seedId);
        if (!res.ok) {
          setMsg(`Error: ${res.error ?? "could not queue backfill"}`);
          return;
        }
        setMsg(`Queued ${res.queued} lead${res.queued === 1 ? "" : "s"} for backfill.`);
        window.dispatchEvent(
          new CustomEvent("open-activity-drawer", {
            detail: { label: `Backfilling @${seed.username}`, total: res.queued, type: "backfill", startedAt: Date.now() },
          }),
        );
      } else if (action === "filter") {
        const res = await triggerSeedFilter(seed.seedId);
        if (!res.ok) {
          setMsg(`Error: ${res.error ?? "could not run filter"}`);
          return;
        }
        // Synchronous and already done by the time this resolves — no drawer,
        // there's nothing left running to watch.
        setMsg(`Filtered ${res.passed + res.rejected} lead${res.passed + res.rejected === 1 ? "" : "s"} — ${res.passed} passed, ${res.rejected} rejected.`);
      } else {
        const res = await triggerSeedVerify(seed.seedId);
        if (!res.ok) {
          setMsg(`Error: ${res.error ?? "could not queue AI verify"}`);
          return;
        }
        setMsg(`Queued ${res.queued} lead${res.queued === 1 ? "" : "s"} for AI verification.`);
        window.dispatchEvent(
          new CustomEvent("open-activity-drawer", {
            detail: { label: `AI verifying @${seed.username}`, total: res.queued, type: "rescore", startedAt: Date.now() },
          }),
        );
      }
      onChanged();
    });

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          <span className="font-medium text-sm truncate">@{seed.username}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {seed.succeeded} ok · {seed.failed} failed
            {seed.busy && " · running"}
          </span>
        </button>

        <select
          value={action}
          onChange={(e) => setAction(e.target.value as ActionKind)}
          disabled={pending}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
          aria-label="Pipeline action"
        >
          {(Object.keys(ACTION_LABELS) as ActionKind[]).map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]} ({pendingCount[a]})
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={pending || done} onClick={runAction}>
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 mr-1.5" />
          )}
          {done ? "Nothing pending" : "Start"}
        </Button>
      </div>

      <div className="mt-2 pl-6">
        <StageList stages={seedStages(seed.funnel)} />
      </div>
      {msg && <p className="mt-1 pl-6 text-xs text-muted-foreground">{msg}</p>}

      {open && (
        <div className="mt-3 pl-6 space-y-1.5 border-l ml-2">
          {seed.runs.map((run) => (
            <div key={run.id} className="pl-3 text-xs">
              <div className="flex items-center gap-2">
                <StatusIcon status={run.status} />
                <span className="text-muted-foreground">
                  {(run.startedAt ?? run.finishedAt ?? "").slice(0, 16).replace("T", " ") || "—"}
                </span>
                <span className="font-medium">{run.status}</span>
              </div>
              <div className="pl-5 mt-0.5">
                <StageList stages={runStages(run)} />
              </div>
              {run.errorMessage && (
                <p className="pl-5 mt-0.5 text-destructive truncate" title={run.errorMessage}>
                  {run.errorMessage}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SeedPipelineList({ initial }: { initial: SeedPipeline[] }) {
  const [seeds, setSeeds] = useState<SeedPipeline[]>(initial);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSeeds(await getSeedPipelines());
    } catch {
      /* transient — keep the last good view rather than blanking the list */
    }
  }, []);

  const busy = seeds.some((s) => s.busy);

  useEffect(() => {
    // Always poll — even when idle, a seed scraped elsewhere (e.g. from the
    // Seeds page) needs to show up here without a manual reload. Just slower
    // than while something in the currently-loaded list is running.
    timer.current = setInterval(refresh, busy ? POLL_MS : IDLE_POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [busy, refresh]);

  if (!seeds.length) return null;

  return (
    <Card>
      <CardContent className="p-0 divide-y">
        {seeds.map((seed) => (
          <SeedCard key={seed.seedId} seed={seed} onChanged={refresh} />
        ))}
      </CardContent>
    </Card>
  );
}
