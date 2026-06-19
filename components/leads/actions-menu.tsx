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
  MoreHorizontal, RefreshCw, XCircle, SearchCode, Upload, Download, Play, DatabaseZap, MailWarning,
} from "lucide-react";
import {
  rescoreAllLeads,
  clearRejectedScores,
  retryFunnelEnrichment,
  rerunFunnelForAllQualified,
  triggerBulkBackfill,
  reEnrichBouncedLeads,
  reenrichLeadsWithoutEmail,
} from "@/app/actions/leads";
import { analyzeAllPending } from "@/app/actions/process-lead";
import { checkEmailBounces } from "@/app/actions/outreach";

const openActivity = (detail?: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent("open-activity-drawer", { detail: detail ?? {} }));

type Props = {
  pendingCount: number;
  scoreableCount: number;
  rejectedWithScore: number;
  missingProgramNames: number;
  backfillCount: number;
  qualifiedFunnelCount: number;
  bouncedCount: number;
  noEmailCount: number;
  exportHref: string;
};

export function LeadsActionsMenu({
  pendingCount,
  scoreableCount,
  rejectedWithScore,
  missingProgramNames,
  backfillCount,
  qualifiedFunnelCount,
  bouncedCount,
  noEmailCount,
  exportHref,
}: Props) {
  const router = useRouter();
  const [, start] = useTransition();
  const [csvOpen, setCsvOpen] = useState(false);

  const run = (action: () => Promise<Record<string, unknown> | unknown>, detail: Record<string, unknown> = {}, refresh = false) => {
    const startedAt = Date.now();
    start(async () => {
      const result = await action();
      const extra = result && typeof result === "object" ? result as Record<string, unknown> : {};
      openActivity({ ...detail, startedAt, ...extra });
      if (refresh) router.refresh();
    });
  };

  const hasBulk = pendingCount > 0 || scoreableCount > 0 || rejectedWithScore > 0 || missingProgramNames > 0 || backfillCount > 0 || qualifiedFunnelCount > 0 || bouncedCount > 0 || noEmailCount > 0;

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
          <DropdownMenuItem
            onClick={() => run(
              () => checkEmailBounces(),
              { label: "Checking Gmail for bounced emails…", type: "bounce_check" },
              true,
            )}
          >
            <MailWarning className="h-4 w-4 mr-2" />
            Check bounces
          </DropdownMenuItem>

          {hasBulk && <DropdownMenuSeparator />}

          {backfillCount > 0 && (
            <DropdownMenuItem onClick={() => run(() => triggerBulkBackfill(), { label: "Backfilling metadata", total: backfillCount, type: "backfill" })}>
              <DatabaseZap className="h-4 w-4 mr-2" />
              Backfill metadata ({backfillCount.toLocaleString()})
            </DropdownMenuItem>
          )}

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

          {qualifiedFunnelCount > 0 && (
            <DropdownMenuItem onClick={() => run(() => rerunFunnelForAllQualified(), { label: "Re-running funnel for all qualified", total: qualifiedFunnelCount, type: "funnel_rerun" })}>
              <SearchCode className="h-4 w-4 mr-2" />
              Re-run funnel — all qualified ({qualifiedFunnelCount})
            </DropdownMenuItem>
          )}

          {noEmailCount > 0 && (
            <DropdownMenuItem onClick={() => run(() => reenrichLeadsWithoutEmail(), { label: "Re-enriching leads without email", total: noEmailCount, type: "reenrich_no_email" }, true)}>
              <MailWarning className="h-4 w-4 mr-2" />
              Re-enrich without email ({noEmailCount})
            </DropdownMenuItem>
          )}

          {bouncedCount > 0 && (
            <DropdownMenuItem onClick={() => run(() => reEnrichBouncedLeads(), { label: "Re-enriching bounced leads", total: bouncedCount, type: "reenrich_bounced" }, true)}>
              <MailWarning className="h-4 w-4 mr-2" />
              Re-enrich bounced ({bouncedCount})
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
