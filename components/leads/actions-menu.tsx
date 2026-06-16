"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { CsvImportButton } from "@/components/leads/csv-import-button";
import {
  MoreHorizontal, RefreshCw, XCircle, SearchCode, Upload, Download, Play,
} from "lucide-react";
import {
  rescoreAllLeads,
  clearRejectedScores,
  retryFunnelEnrichment,
} from "@/app/actions/leads";
import { analyzeAllPending } from "@/app/actions/process-lead";

const openActivity = (detail?: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent("open-activity-drawer", { detail: detail ?? {} }));

type Props = {
  pendingCount: number;
  scoreableCount: number;
  rejectedWithScore: number;
  missingProgramNames: number;
  exportHref: string;
};

export function LeadsActionsMenu({
  pendingCount,
  scoreableCount,
  rejectedWithScore,
  missingProgramNames,
  exportHref,
}: Props) {
  const router = useRouter();
  const [, start] = useTransition();
  const [csvOpen, setCsvOpen] = useState(false);

  const run = (action: () => Promise<unknown>, detail: Record<string, unknown> = {}, refresh = false) => {
    const startedAt = Date.now();
    start(async () => {
      await action();
      openActivity({ ...detail, startedAt });
      if (refresh) router.refresh();
    });
  };

  const hasBulk = pendingCount > 0 || scoreableCount > 0 || rejectedWithScore > 0 || missingProgramNames > 0;

  return (
    <>
      <CsvImportButton open={csvOpen} onOpenChange={setCsvOpen} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => setCsvOpen(true)}>
            <Download className="h-4 w-4 mr-2" />
            Import CSV
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={exportHref}>
              <Upload className="h-4 w-4 mr-2" />
              Export CSV
            </a>
          </DropdownMenuItem>

          {hasBulk && <DropdownMenuSeparator />}

          {pendingCount > 0 && (
            <DropdownMenuItem onClick={() => run(() => analyzeAllPending(), { label: "Analyzing leads", total: pendingCount, type: "analyze" })}>
              <Play className="h-4 w-4 mr-2" />
              Analyze unanalyzed ({pendingCount})
            </DropdownMenuItem>
          )}

          {scoreableCount > 0 && (
            <DropdownMenuItem onClick={() => run(() => rescoreAllLeads("qualified_review"), { label: "Rescoring leads", total: scoreableCount, type: "rescore" })}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Rescore qualified ({scoreableCount})
            </DropdownMenuItem>
          )}

          {rejectedWithScore > 0 && (
            <DropdownMenuItem onClick={() => run(() => clearRejectedScores(), {}, true)}>
              <XCircle className="h-4 w-4 mr-2" />
              Clear rejected scores ({rejectedWithScore})
            </DropdownMenuItem>
          )}

          {missingProgramNames > 0 && (
            <DropdownMenuItem onClick={() => run(() => retryFunnelEnrichment(50), {}, true)}>
              <SearchCode className="h-4 w-4 mr-2" />
              Re-enrich programs ({missingProgramNames})
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
