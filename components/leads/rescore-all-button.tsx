"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2, CheckCircle2 } from "lucide-react";
import { rescoreAllLeads } from "@/app/actions/leads";

type State = "idle" | "queuing" | "done";

export function RescoreAllButton({ totalScorable }: { totalScorable: number }) {
  const [, start] = useTransition();
  const [state, setState] = useState<State>("idle");

  const handleRun = () => {
    setState("queuing");
    start(async () => {
      await rescoreAllLeads("qualified_review");
      setState("done");
    });
  };

  if (state === "done") {
    return (
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
        <span>Queued — watch Activity for progress</span>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={state === "queuing" || totalScorable === 0}
      onClick={handleRun}
      title={`Re-run AI scoring for ${totalScorable} qualified + review leads`}
    >
      {state === "queuing"
        ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
      {state === "queuing" ? "Queuing…" : `Rescore all (${totalScorable})`}
    </Button>
  );
}
