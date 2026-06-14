"use client";
import { useState, useTransition } from "react";
import { Play, Loader2, Check, AlertCircle, Users, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { processLead, processLeadsBatch } from "@/app/actions/process-lead";
import { useAnalyzeQueue } from "@/components/leads/analyze-context";

type Props = {
  leadId: string;
  status: string;
  sourceSeedId?: string | null;
  sourceUsername?: string | null;
  size?: "sm" | "default";
};

export function ProcessButton({ leadId, status, sourceSeedId, sourceUsername, size = "sm" }: Props) {
  const [pending, start] = useTransition();
  const [fired, setFired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { queuedLeads, markQueued } = useAnalyzeQueue();

  const isQueued = fired || queuedLeads.has(leadId);

  if (status !== "pending" && !isQueued) return null;

  if (isQueued) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Queued for processing">
        <Check className="h-3 w-3 text-green-600" /> Queued
      </span>
    );
  }

  const runSingle = () => {
    setError(null);
    setOpen(false);
    start(async () => {
      const r = await processLead(leadId);
      if (r.ok) { markQueued([leadId]); setFired(true); }
      else setError(r.error ?? "failed");
    });
  };

  const runBatch = (limit: number | "all") => {
    if (!sourceSeedId) return;
    setError(null);
    setOpen(false);
    start(async () => {
      const r = await processLeadsBatch(sourceSeedId, limit);
      if (r.ok) {
        markQueued(r.leadIds);
        setFired(true);
      } else {
        setError(r.error ?? "failed");
      }
    });
  };

  const trigger = (
    <Button
      variant="outline"
      size={size}
      disabled={pending}
      onClick={runSingle}
      title="Analyze this account"
    >
      {pending
        ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        : error
        ? <AlertCircle className="h-3 w-3 mr-1 text-red-600" />
        : <Play className="h-3 w-3 mr-1" />}
      {pending ? "Starting…" : error ? "Try again" : "Analyze"}
    </Button>
  );

  if (!sourceSeedId) {
    return (
      <div className="flex flex-col gap-1">
        {trigger}
        {error && <span className="text-[10px] text-red-600 max-w-[180px] truncate" title={error}>{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          asChild
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {trigger}
        </PopoverTrigger>
        <PopoverContent
          className="w-52 p-2 space-y-1"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <button
            onClick={runSingle}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left"
          >
            <Play className="h-3.5 w-3.5 shrink-0" />
            Just this one
          </button>
          <button
            onClick={() => runBatch(10)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left"
          >
            <Users className="h-3.5 w-3.5 shrink-0" />
            Next 10 from {sourceUsername ? `@${sourceUsername}` : "this source"}
          </button>
          <button
            onClick={() => runBatch("all")}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left"
          >
            <ListChecks className="h-3.5 w-3.5 shrink-0" />
            All from {sourceUsername ? `@${sourceUsername}` : "this source"}
          </button>
        </PopoverContent>
      </Popover>
      {error && <span className="text-[10px] text-red-600 max-w-[180px] truncate" title={error}>{error}</span>}
    </div>
  );
}
