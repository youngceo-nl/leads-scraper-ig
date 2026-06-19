"use client";
import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { ScrollText, X, AlertTriangle, CheckCircle2, Clock, LayoutDashboard, Loader2 } from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { actionLabel, actionIsPositive } from "@/lib/labels";
import { getPendingCount, getRescoreProgress, getBackfillProgress, cancelBackfill } from "@/app/actions/leads";
import { cancelCrawl, getCrawlJobProgress, getActiveJobs, type ActiveJob } from "@/app/actions/crawl-jobs";

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
  crawl_job_id?: string;
};

export function ActivityDrawerButton() {
  const [open, setOpen] = useState(false);
  const [crawl, setCrawl] = useState<CrawlLog[]>([]);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [tab, setTab] = useState<"activity" | "errors">("activity");
  const [bulkJob, setBulkJob] = useState<BulkJob | null>(null);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);

  // Restore persisted job after mount — localStorage is client-only
  useEffect(() => {
    try {
      const saved = localStorage.getItem("bulk_job");
      if (saved) setBulkJob(JSON.parse(saved) as BulkJob);
    } catch { /* ignore */ }
  }, []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const drawerRef = useRef<HTMLDivElement>(null);
  const bulkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const saveBulkJob = (job: BulkJob | null) => {
    setBulkJob(job);
    if (job) localStorage.setItem("bulk_job", JSON.stringify(job));
    else localStorage.removeItem("bulk_job");
  };

  const newest = crawl[0]?.created_at;
  const active = newest ? Date.now() - new Date(newest).getTime() < 30_000 : false;
  const hasRunningJobs = activeJobs.length > 0;

  // Fetch logs + auto-detect running jobs
  useEffect(() => {
    const sb = createClient();
    let cancelled = false;

    const tick = async () => {
      const [{ data: c }, { data: e }, jobs] = await Promise.all([
        sb.from("crawl_logs").select("*").order("created_at", { ascending: false }).limit(100),
        sb.from("error_logs").select("*").order("created_at", { ascending: false }).limit(50),
        getActiveJobs(),
      ]);
      if (cancelled) return;
      if (c) setCrawl(c as CrawlLog[]);
      if (e) setErrors(e as ErrorLog[]);
      setActiveJobs(jobs);

      // Auto-open drawer when a job starts (and it's not already open)
      if (jobs.length > 0 && !open) {
        // don't auto-open — user controls that — but do pulse the button
      }
    };

    tick();
    const id = setInterval(tick, open ? 2500 : 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [open]);

  // Open via event + receive bulk job details
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<BulkJob> | undefined;
      setOpen(true);
      setTab("activity");
      if (detail?.total && detail?.label && detail?.startedAt) {
        saveBulkJob({ label: detail.label, total: detail.total, type: detail.type ?? "", startedAt: detail.startedAt, done: 0, crawl_job_id: detail.crawl_job_id as string | undefined });
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
      } else if (bulkJob.type === "backfill") {
        const remaining = await getBackfillProgress();
        done = bulkJob.total - remaining;
      } else if (bulkJob.type === "crawl" && bulkJob.crawl_job_id) {
        const p = await getCrawlJobProgress(bulkJob.crawl_job_id);
        done = p.scraped;
        if (p.total > 0) {
          setBulkJob((prev) => prev ? { ...prev, total: Math.max(prev.total, p.total), done: Math.max(prev.done, done) } : null);
          if (p.status === "completed" || p.status === "failed" || p.status === "cancelled") {
            clearInterval(bulkPollRef.current!);
            bulkPollRef.current = null;
            localStorage.removeItem("bulk_job");
          }
          return;
        }
      }
      const updated = (prev: BulkJob | null) => prev ? { ...prev, done: Math.max(prev.done, done) } : null;
      setBulkJob((prev) => {
        const next = updated(prev);
        if (next) localStorage.setItem("bulk_job", JSON.stringify(next));
        return next;
      });
      if (bulkJob.type !== "crawl" && done >= bulkJob.total) {
        clearInterval(bulkPollRef.current!);
        bulkPollRef.current = null;
        localStorage.removeItem("bulk_job");
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
          {(active || hasRunningJobs) && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-green-500">
              <span className="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-75" />
            </span>
          )}
          {errors.length > 0 && !active && !hasRunningJobs && (
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

      {mounted && createPortal(
        <>
          {open && <div className="fixed inset-0 z-[99] bg-black/20" aria-hidden="true" onClick={() => setOpen(false)} />}
          <div
            ref={drawerRef}
            className={`fixed top-0 right-0 h-full w-[420px] bg-background border-l shadow-xl z-[100] flex flex-col transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
          >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm">Activity</h2>
            {(active || hasRunningJobs) && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-green-600 bg-green-50 dark:bg-green-950 px-1.5 py-0.5 rounded-full">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                Live
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/logs"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground p-1 rounded"
              title="Go to Pipeline page"
            >
              <LayoutDashboard className="h-4 w-4" />
            </Link>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground p-1 rounded" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
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

        {/* Auto-detected running jobs */}
        {tab === "activity" && activeJobs.length > 0 && (
          <div className="border-b shrink-0">
            {activeJobs.map((job) => (
              <ActiveJobRow key={job.id} job={job} />
            ))}
          </div>
        )}

        {/* Bulk job progress (localStorage-backed) */}
        {tab === "activity" && bulkJob && bulkJob.done < bulkJob.total && (
          <BulkProgress job={bulkJob} onCancel={() => saveBulkJob(null)} />
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
        </>,
        document.body
      )}
    </>
  );
}

function ActiveJobRow({ job }: { job: ActiveJob }) {
  const isPlaywright = job.type === "crawl" && job.scraped === 0 && job.status === "running";
  const pct = job.total > 0 ? Math.min(100, Math.round((job.scraped / job.total) * 100)) : null;
  const [stopping, setStopping] = useState(false);

  const handleStop = async () => {
    setStopping(true);
    if (job.type === "crawl") await cancelCrawl(job.id);
    else if (job.type === "backfill") await cancelBackfill();
    setStopping(false);
  };

  return (
    <div className="px-4 py-3 bg-blue-50/50 dark:bg-blue-950/30 space-y-1.5">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
        <span className="text-xs font-medium flex-1 truncate">{job.label}</span>
        {job.total > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
            {job.scraped} / {job.total}
          </span>
        )}
        <button
          onClick={handleStop}
          disabled={stopping}
          className="text-muted-foreground hover:text-destructive transition-colors ml-1 disabled:opacity-40"
          title="Stop"
        >
          {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3.5 w-3.5" />}
        </button>
      </div>
      {isPlaywright ? (
        <p className="text-[11px] text-muted-foreground pl-5">
          Playwright browser is open — this takes 1–3 min, hang tight
        </p>
      ) : pct !== null ? (
        <div className="pl-5 space-y-1">
          <div className="h-1 bg-blue-100 dark:bg-blue-900 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[10px] text-muted-foreground">{pct}% done</p>
        </div>
      ) : null}
    </div>
  );
}

function BulkProgress({ job, onCancel }: { job: BulkJob; onCancel: () => void }) {
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

  const [stopping, setStopping] = useState(false);

  const handleStop = async () => {
    setStopping(true);
    if (job.type === "backfill") await cancelBackfill();
    else if (job.crawl_job_id) await cancelCrawl(job.crawl_job_id);
    onCancel();
  };

  return (
    <div className="px-4 py-3 border-b bg-muted/30 shrink-0 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{job.label}</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground tabular-nums">{job.done} / {job.total}</span>
          <button
            onClick={handleStop}
            disabled={stopping}
            className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
            title="Stop"
          >
            {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          </button>
        </div>
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
