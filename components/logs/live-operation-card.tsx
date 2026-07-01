"use client";
import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, Clock, Cpu, Zap, AlertTriangle, X } from "lucide-react";
import { getOperationStatus, dismissStalledBackfill, type OperationStatus } from "@/app/actions/leads";

const OPERATION_LABELS: Record<string, string> = {
  backfill: "Backfilling metadata",
  analyze: "Analyzing leads",
  crawl: "Scraping following list",
};

const METHOD_LABELS: Record<string, string> = {
  cookie: "Cookie · BrowserSession",
  apify: "Apify",
};

function etaLabel(min: number | null): string | null {
  if (min == null) return null;
  if (min < 1) return "< 1 min";
  if (min < 60) return `~${min} min`;
  return `~${Math.round(min / 60)}h`;
}

export function LiveOperationCard() {
  const [status, setStatus] = useState<OperationStatus | null>(null);
  const [hadActivity, setHadActivity] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Track last time we saw progress to detect stalled state
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);

  const poll = useCallback(async () => {
    const s = await getOperationStatus();
    setStatus((prev) => {
      if (s.isRunning) setLastProgressAt(Date.now());
      else if (!prev?.isRunning && s.remaining > 0 && prev?.remaining === s.remaining) {
        // remaining unchanged and not running — already stalled
      }
      return s;
    });
    if (s.isRunning || s.operation) setHadActivity(true);
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [poll]);

  if (dismissed) return null;
  if (!status || (!status.isRunning && !status.operation && !hadActivity)) return null;

  const pct = status.total > 0 ? Math.min(100, Math.round((status.succeeded / status.total) * 100)) : 0;
  const opLabel = OPERATION_LABELS[status.operation ?? ""] ?? status.operation ?? "Running";
  const methodLabel = status.method ? METHOD_LABELS[status.method] ?? status.method : null;
  const eta = etaLabel(status.etaMin);
  const done = !status.isRunning && status.remaining === 0 && hadActivity;

  // Stalled: not running, still has remaining accounts, and it's been a bit since last progress
  const stalledSec = lastProgressAt ? Math.round((Date.now() - lastProgressAt) / 1000) : null;
  const stalled = !status.isRunning && status.remaining > 0 && hadActivity;

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${
      stalled
        ? "border-yellow-200 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/30"
        : status.isRunning
        ? "border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30"
        : done
        ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30"
        : "border-border bg-muted/30"
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {stalled ? (
            <AlertTriangle className="h-3.5 w-3.5 text-yellow-600" />
          ) : status.isRunning ? (
            <span className="relative h-2.5 w-2.5 flex-shrink-0">
              <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-60" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-blue-500 block" />
            </span>
          ) : done ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-sm font-semibold">
            {done ? "Completed" : stalled ? `${opLabel} — stalled` : status.isRunning && status.succeeded === 0 ? `${opLabel} — starting up…` : opLabel}
          </span>
          {status.isRunning && (
            <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900 px-1.5 py-0.5 rounded-full">
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {methodLabel && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Cpu className="h-3 w-3" />
              {methodLabel}
            </div>
          )}
          {stalled && (
            <button
              onClick={async () => { await dismissStalledBackfill(); setDismissed(true); }}
              className="text-xs text-yellow-700 hover:text-yellow-900 flex items-center gap-0.5 underline underline-offset-2"
            >
              <X className="h-3 w-3" /> Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Fetched</span>
          <span className="text-xl font-bold tabular-nums text-green-700 dark:text-green-400">{status.succeeded.toLocaleString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Failed</span>
          <span className={`text-xl font-bold tabular-nums ${status.failed > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
            {status.failed.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Remaining</span>
          <span className={`text-xl font-bold tabular-nums ${stalled && status.remaining > 0 ? "text-yellow-700 dark:text-yellow-400" : ""}`}>
            {status.remaining.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      {status.total > 0 && (
        <div className="space-y-1">
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${
                stalled ? "bg-yellow-500" : done ? "bg-green-500" : "bg-blue-500"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {status.succeeded.toLocaleString()} / {status.total.toLocaleString()} · {pct}%
            </span>
            <div className="flex items-center gap-2">
              {status.isRunning && status.perMin > 0 && (
                <span className="flex items-center gap-0.5">
                  <Zap className="h-2.5 w-2.5" />
                  {Math.round(status.perMin)}/min
                </span>
              )}
              {eta && !stalled && <span>ETA {eta}</span>}
              {stalled && (
                <span className="text-yellow-700 dark:text-yellow-400">
                  {status.remaining} account{status.remaining !== 1 ? "s" : ""} may be private or unreachable
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
