"use client";
import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, Clock, Send, XCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { getFollowupBatchProgress, type FollowupBatchProgress } from "@/app/actions/outreach";

function etaLabel(pendingCount: number, intervalMinutes: number): string {
  const minutes = pendingCount * intervalMinutes;
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `~${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

export function FollowupBatchCard({ initial }: { initial: FollowupBatchProgress }) {
  const [data, setData] = useState(initial);

  const poll = useCallback(async () => {
    const next = await getFollowupBatchProgress();
    setData(next);
  }, []);

  useEffect(() => {
    const interval = data.isActive ? 15_000 : 60_000;
    const id = setInterval(poll, interval);
    return () => clearInterval(id);
  }, [poll, data.isActive]);

  const { sent, pending, failed, isActive, intervalMinutes, recentLogs } = data;
  const total = sent + pending + failed;
  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  const done = total > 0 && pending === 0 && !isActive;

  if (total === 0 && recentLogs.length === 0) return null;

  return (
    <div className={`rounded-lg border p-4 space-y-4 ${
      isActive
        ? "border-blue-200 bg-blue-50/50"
        : done
        ? "border-green-200 bg-green-50/50"
        : "border-border bg-muted/30"
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isActive ? (
            <span className="relative h-2.5 w-2.5 flex-shrink-0">
              <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-60" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-blue-500 block" />
            </span>
          ) : done ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-sm font-semibold">Follow-up batch</span>
          {isActive && (
            <span className="text-[10px] font-medium text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded-full">
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Send className="h-3 w-3" />
          {intervalMinutes} min intervals
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Sent</span>
          <span className="text-xl font-bold tabular-nums text-green-700">{sent.toLocaleString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Failed</span>
          <span className={`text-xl font-bold tabular-nums ${failed > 0 ? "text-red-600" : "text-muted-foreground"}`}>
            {failed.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Remaining</span>
          <span className="text-xl font-bold tabular-nums">{pending.toLocaleString()}</span>
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="space-y-1">
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${done ? "bg-green-500" : "bg-blue-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="tabular-nums">{sent.toLocaleString()} / {total.toLocaleString()} · {pct}%</span>
            {pending > 0 && !done && (
              <span>ETA {etaLabel(pending, intervalMinutes)}</span>
            )}
          </div>
        </div>
      )}

      {/* Recent log */}
      {recentLogs.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Recent activity</p>
          <div className="space-y-0.5 max-h-52 overflow-y-auto pr-1">
            {recentLogs.map((log) => (
              <div key={log.id} className="flex items-start gap-2 text-xs py-0.5">
                {log.action === "followup_sent" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 flex-shrink-0" />
                )}
                <span className="font-medium flex-shrink-0">@{log.profile_username}</span>
                {log.detail && (
                  <span className="text-muted-foreground truncate">{log.detail}</span>
                )}
                <span className="text-muted-foreground flex-shrink-0 ml-auto">
                  {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
