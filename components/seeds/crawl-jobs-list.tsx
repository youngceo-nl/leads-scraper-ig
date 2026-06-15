"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { LiveStatus } from "@/components/ui/live-status";
import { formatDistanceToNow } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { cancelCrawl, retryCrawl } from "@/app/actions/crawl-jobs";
import { statusLabel } from "@/lib/labels";
import { X, RotateCw } from "lucide-react";

type Row = {
  id: string;
  seed_id: string;
  status: string;
  max_depth: number;
  current_depth: number;
  profiles_scraped: number;
  new_leads: number;
  qualified_count: number;
  rejected_count: number;
  expected_profiles: number | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  seeds: { username: string } | null;
};

const ACTIVE = new Set(["queued", "running"]);

export function CrawlJobsList({ jobs: initial }: { jobs: Row[] }) {
  const [jobs, setJobs] = useState<Row[]>(initial);
  const hasActive = jobs.some((j) => ACTIVE.has(j.status));

  useEffect(() => {
    const sb = createClient();
    let cancelled = false;

    const tick = async () => {
      const { data } = await sb
        .from("crawl_jobs")
        .select("*, seeds(username)")
        .order("created_at", { ascending: false })
        .limit(15);
      if (!cancelled && data) setJobs(data as Row[]);
    };

    const interval = hasActive ? 2500 : 10000;
    const id = setInterval(tick, interval);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasActive]);

  if (jobs.length === 0) return <p className="text-sm text-muted-foreground">No searches yet. Start one from a source account above.</p>;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <LiveStatus active={hasActive} />
      </div>
      <ul className="divide-y">
        {jobs.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
      </ul>
    </div>
  );
}

function JobRow({ job }: { job: Row }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const expected = job.expected_profiles ?? 0;
  const scraped = job.profiles_scraped ?? 0;
  const pct = expected > 0 ? Math.min(100, Math.round((scraped / expected) * 100)) : null;
  const canCancel = job.status === "running" || job.status === "queued";
  const canRetry = job.status === "failed" || job.status === "cancelled";

  return (
    <li className="py-3 grid grid-cols-[1fr_auto] gap-4 text-sm">
      <div className="space-y-1.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/seeds/jobs/${job.id}`}
            className="font-medium hover:underline"
          >
            @{job.seeds?.username ?? "—"}
          </Link>
          <Badge variant={badgeVariant(job.status)}>{statusLabel(job.status)}</Badge>
          <span className="text-xs text-muted-foreground">level {job.current_depth} of {job.max_depth}</span>
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs flex-wrap">
          {scraped > 0 ? (
            <>
              <span className="tabular-nums text-muted-foreground">
                <b className="text-foreground">{scraped}</b> checked
              </span>
              <span className="tabular-nums">
                <b className="text-green-600">{job.new_leads ?? 0}</b>
                <span className="text-muted-foreground"> new</span>
              </span>
              <span className="tabular-nums">
                <b className="text-muted-foreground">{scraped - (job.new_leads ?? 0)}</b>
                <span className="text-muted-foreground"> already known</span>
              </span>
              {job.qualified_count > 0 && (
                <span><span className="text-green-600 font-medium">{job.qualified_count}</span> <span className="text-muted-foreground">qualified</span></span>
              )}
              {job.rejected_count > 0 && (
                <span><span className="text-red-600 font-medium">{job.rejected_count}</span> <span className="text-muted-foreground">not a fit</span></span>
              )}
            </>
          ) : (
            job.status === "completed" && (
              <span className="text-muted-foreground italic">Nothing scraped</span>
            )
          )}
        </div>

        {(pct != null || job.status === "running") && (
          <div className="flex items-center gap-2 max-w-md">
            <Progress
              value={pct}
              state={job.status === "running" ? "running" : job.status === "completed" ? "done" : "idle"}
              size="sm"
            />
            {pct != null && <span className="text-[11px] text-muted-foreground tabular-nums w-9 text-right">{pct}%</span>}
          </div>
        )}

        {job.error_message && (
          <p className="text-xs text-destructive truncate" title={job.error_message}>
            {job.error_message}
          </p>
        )}
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </div>

      <div className="flex items-start gap-1.5">
        {canCancel && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await cancelCrawl(job.id);
                setMsg("error" in res && res.error ? `Error: ${res.error}` : "Stopping…");
              })
            }
            title="Stop this search"
          >
            <X className="h-3.5 w-3.5 mr-1" /> Cancel
          </Button>
        )}
        {canRetry && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await retryCrawl(job.id);
                setMsg("error" in res && res.error ? `Error: ${res.error}` : "Search restarted.");
              })
            }
            title="Run this search again"
          >
            <RotateCw className="h-3.5 w-3.5 mr-1" /> Try again
          </Button>
        )}
      </div>
    </li>
  );
}

function badgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running") return "default";
  if (status === "completed") return "secondary";
  if (status === "failed" || status === "cancelled") return "destructive";
  return "outline";
}
