"use client";
import { useEffect, useState, useRef } from "react";
import { ScrollText, X, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { actionLabel, actionIsPositive } from "@/lib/labels";
import { getPendingCount, getRescoreProgress } from "@/app/actions/leads";

type CrawlLog = {
  id: string;
  action: string;
  profile_username: string;
  depth: number;
  detail: string | null;
  created_at: string;
};

type ErrorLog = {
  id: string;
  context: string;
  error_message: string;
  created_at: string;
};

type BulkJob = {
  label: string;
  total: number;
  type: "analyze" | "rescore" | string;
  startedAt: number;
  done: number;
};

export function ActivityDrawerButton() {
  const [open, setOpen] = useState(false);
  const [crawl, setCrawl] = useState<CrawlLog[]>([]);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [tab, setTab] = useState<"activity" | "errors">("activity");
  const [bulkJob, setBulkJob] = useState<BulkJob | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const bulkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const newest = crawl[0]?.created_at;
  const active = newest ? Date.now() - new Date(newest).getTime() < 30_000 : false;

  // Fetch logs on mount and poll while open
  useEffect(() => {
    const sb = createClient();
    let cancelled = false;

    const tick = async () => {
      const [{ data: c }, { data: e }] = await Promise.all([
        sb.from("crawl_logs").select("*").order("created_at", { ascending: false }).limit(100),
        sb.from("error_logs").select("*").order("created_at", { ascending: false }).limit(50),
      ]);
      if (cancelled) return;
      if (c) setCrawl(c as CrawlLog[]);
      if (e) setErrors(e as ErrorLog[]);
    };

    tick();
    const id = setInterval(tick, open ? 2500 : 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [open]);

  // Open via event + receive bulk job details
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<BulkJob> | undefined;
      setOpen(true);
      setTab("activity");
      if (detail?.total && detail?.label && detail?.startedAt) {
        setBulkJob({ label: detail.label, total: detail.total, type: detail.type ?? "", startedAt: detail.startedAt, done: 0 });
      }
    };
    window.addEventListener("open-activity-drawer", handler);
    return () => window.removeEventListener("open-activity-drawer", handler);
  }, []);

  // Poll bulk job progress
  useEffect(() => {
    if (!bulkJob) return;
    if (bulkPollRef.current) clearInterval(bulkPollRef.current);

    const poll = async () => {
      let done = 0;
      if (bulkJob.type === "analyze") {
        const remaining = await getPendingCount();
        done = bulkJob.total - remaining;
      } else if (bulkJob.type === "rescore") {
        const p = await getRescoreProgress(new Date(bulkJob.startedAt).toISOString());
        done = p.processed;
      }
      setBulkJob((prev) => prev ? { ...prev, done: Math.max(prev.done, done) } : null);
      if (done >= bulkJob.total) {
        clearInterval(bulkPollRef.current!);
        bulkPollRef.current = null;
      }
    };

    poll();
    bulkPollRef.current = setInterval(poll, 3000);
    return () => { if (bulkPollRef.current) clearInterval(bulkPollRef.current); };
  }, [bulkJob?.startedAt]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors w-full text-left"
      >
        <span className="relative">
          <ScrollText className="h-4 w-4" />
          {active && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-green-500">
              <span className="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-75" />
            </span>
          )}
          {errors.length > 0 && !active && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
          )}
        </span>
        <span className="flex-1">Activity</span>
        {errors.length > 0 && (
          <span className="bg-red-500 text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5 leading-none tabular-nums">
            {errors.length}
          </span>
        )}
      </button>

      {open && <div className="fixed inset-0 z-40 bg-black/20" aria-hidden="true" />}

      <div
        ref={drawerRef}
        className={`fixed top-0 right-0 h-full w-[420px] bg-background border-l shadow-xl z-50 flex flex-col transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm">Activity</h2>
            {active && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-green-600 bg-green-50 dark:bg-green-950 px-1.5 py-0.5 rounded-full">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                Live
              </span>
            )}
          </div>
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground p-1 rounded" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b shrink-0 text-sm">
          <button
            onClick={() => setTab("activity")}
            className={`flex-1 py-2 font-medium transition-colors ${tab === "activity" ? "border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            All activity
          </button>
          <button
            onClick={() => setTab("errors")}
            className={`flex-1 py-2 font-medium transition-colors flex items-center justify-center gap-1.5 ${tab === "errors" ? "border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            Problems
            {errors.length > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5 leading-none">
                {errors.length}
              </span>
            )}
          </button>
        </div>

        {/* Bulk job progress */}
        {tab === "activity" && bulkJob && bulkJob.done < bulkJob.total && (
          <BulkProgress job={bulkJob} />
        )}

        {/* Log list */}
        <div className="flex-1 overflow-y-auto">
          {tab === "activity" ? (
            crawl.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm gap-2">
                <Clock className="h-5 w-5" />
                No recent activity
              </div>
            ) : (
              <div className="divide-y">
                {crawl.map((row) => (
                  <div key={row.id} className="px-4 py-2.5 flex gap-3 items-start">
                    <div className="mt-0.5 shrink-0">
                      {actionIsPositive(row.action)
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        : <span className="h-3.5 w-3.5 rounded-full bg-muted-foreground/30 inline-block" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-medium">{actionLabel(row.action)}</span>
                        <span className="text-xs text-muted-foreground truncate">@{row.profile_username}</span>
                      </div>
                      {row.detail && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{row.detail}</p>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">
                      {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            errors.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                No problems
              </div>
            ) : (
              <div className="divide-y">
                {errors.map((e) => (
                  <div key={e.id} className="px-4 py-2.5 flex gap-3 items-start">
                    <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-red-600">{e.context}</div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 break-words">{e.error_message}</p>
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">
                      {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}

function BulkProgress({ job }: { job: BulkJob }) {
  const pct = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const elapsedMin = (Date.now() - job.startedAt) / 60_000;
  const perMin = elapsedMin > 0.1 ? job.done / elapsedMin : null;
  const remaining = job.total - job.done;
  const etaMin = perMin && perMin > 0 ? remaining / perMin : null;

  const eta = etaMin == null
    ? null
    : etaMin < 1 ? "< 1 min"
    : etaMin < 60 ? `~${Math.round(etaMin)} min`
    : `~${Math.round(etaMin / 60)}h`;

  return (
    <div className="px-4 py-3 border-b bg-muted/30 shrink-0 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{job.label}</span>
        <span className="text-muted-foreground tabular-nums">{job.done} / {job.total}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{pct}% done{perMin ? ` · ${Math.round(perMin)}/min` : ""}</span>
        {eta && <span>ETA {eta}</span>}
      </div>
    </div>
  );
}
