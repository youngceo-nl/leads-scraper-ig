"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { XCircle, Loader2, CheckCircle2 } from "lucide-react";
import { clearRejectedScores } from "@/app/actions/leads";

type State = "idle" | "clearing" | "done";

export function ClearRejectedScoresButton({ count }: { count: number }) {
  const [, start] = useTransition();
  const [state, setState] = useState<State>("idle");

  const handleClick = () => {
    setState("clearing");
    start(async () => {
      await clearRejectedScores();
      setState("done");
    });
  };

  if (state === "done") {
    return (
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
        <span>Scores cleared</span>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={state === "clearing"}
      onClick={handleClick}
      title={`Remove scores from ${count} rejected leads`}
    >
      {state === "clearing"
        ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        : <XCircle className="h-3.5 w-3.5 mr-1.5" />}
      {state === "clearing" ? "Clearing…" : `Clear rejected scores (${count})`}
    </Button>
  );
}
