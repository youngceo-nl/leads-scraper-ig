"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Handshake, Upload } from "lucide-react";
import type { AccountHandover } from "@/lib/handover/overview";
import type { ColumnMapping, DetectedColumns } from "@/lib/handover/format";
import { AccountHandoverBlock } from "@/components/handover/account-handover-block";
import { ColumnMappingDialog } from "@/components/handover/column-mapping-dialog";
import { applyEnrichmentGlobal, getHandoverAccounts, previewHandoverCsv } from "@/app/actions/handover";
import { Button } from "@/components/ui/button";

const POLL_MS = 5000;
const IDLE_POLL_MS = 20000;

/**
 * The per-account handover blocks, collapsed by default so they never push the
 * leads table off screen as source accounts accumulate.
 */
export function HandoverSection({ initial }: { initial: AccountHandover[] }) {
  const [accounts, setAccounts] = useState<AccountHandover[]>(initial);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  // Set only when the CSV's identifying/email column couldn't be confidently
  // recognized — holds the raw text so the dialog's confirmed mapping can be
  // applied to the exact file the operator picked, without re-reading it.
  const [pendingCsv, setPendingCsv] = useState<{ text: string; headers: string[]; detected: DetectedColumns } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await getHandoverAccounts());
    } catch {
      /* transient — keep the last good view rather than blanking the section */
    }
  }, []);

  // A qualified-lead count can climb by the hundreds during an active
  // full-account backfill/scoring run — without this the section only ever
  // shows whatever was true at the last full page load, which reads as
  // "stuck at 0/N" even though real progress is happening every minute.
  // Always polling (not just while processing) matches SeedPipelineList's
  // reasoning: an account finishing elsewhere still needs to show up here
  // without a manual reload, just at a slower cadence when idle.
  const anyProcessing = accounts.some((a) => a.stillProcessing);
  useEffect(() => {
    timer.current = setInterval(refresh, anyProcessing ? POLL_MS : IDLE_POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [anyProcessing, refresh]);

  if (!accounts.length) return null;

  const ready = accounts.reduce((sum, a) => sum + a.total, 0);
  const handedOver = accounts.reduce((sum, a) => sum + a.done, 0);
  const openBatches = accounts.filter((a) => a.openBatch).length;

  // Plain async helper, not itself wrapped in a transition — both callers
  // below (the auto-import path and the dialog's confirm) run it inside their
  // own single `start()`, so each user-triggered action is exactly one
  // transition rather than two nested ones.
  const runImport = async (text: string, mapping?: ColumnMapping) => {
    setMessage(null);
    const result = await applyEnrichmentGlobal(text, mapping);
    if (!result.ok) {
      setMessage(`Error: ${result.error ?? "could not import"}`);
      return;
    }
    const parts = [`${result.withEmail} email${result.withEmail === 1 ? "" : "s"} found`];
    if (result.withoutEmail) parts.push(`${result.withoutEmail} with none`);
    if (result.markedBad) parts.push(`${result.markedBad} marked bad`);
    if (result.skipped) parts.push(`${result.skipped} row(s) skipped (no match)`);
    if (result.closedBatches) {
      parts.push(`${result.closedBatches} batch${result.closedBatches === 1 ? "" : "es"} closed`);
    }
    setMessage(parts.join(", ") + ".");
    refresh();
  };

  // One CSV can cover leads from several dispatched accounts at once — rows
  // are matched back to leads by username, so there's nothing per-account to
  // route here (see applyEnrichmentAll).
  //
  // Previewed before importing: if the identifying or email column can't be
  // confidently recognized, that's ambiguous rather than "column doesn't
  // exist" — a wrongly-named column looks identical to a missing one from
  // header-matching alone, and only the operator can actually tell the two
  // apart. Silently guessing wrong here is exactly how a whole batch of found
  // emails went missing once already (see lib/handover/format.ts).
  const upload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      start(async () => {
        setMessage(null);
        const preview = await previewHandoverCsv(text);
        if (!preview.ok) {
          setMessage(`Error: ${preview.error ?? "could not read file"}`);
          return;
        }
        if (preview.detected.username == null || preview.detected.email == null) {
          setPendingCsv({ text, headers: preview.headers, detected: preview.detected });
          return;
        }
        await runImport(text);
      });
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsText(file);
  };

  return (
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left text-sm hover:opacity-80 transition-opacity"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <Handshake className="h-4 w-4" />
          <span className="font-medium">Handover</span>
          <span className="text-muted-foreground text-xs">
            {accounts.length} account{accounts.length === 1 ? "" : "s"} · {ready.toLocaleString()} ready for handover · {handedOver.toLocaleString()} handed over
            {openBatches > 0 && ` · ${openBatches} batch${openBatches === 1 ? "" : "es"} open`}
          </span>
        </button>

        <Button size="sm" variant="outline" disabled={pending} onClick={() => fileRef.current?.click()}>
          <Upload className="h-3.5 w-3.5 mr-1" />
          Upload enriched CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />
      </div>

      {message && <p className="px-3 pb-2 text-xs text-muted-foreground">{message}</p>}

      {open && (
        <div className="p-3 pt-0 space-y-2">
          {accounts.map((account) => (
            <AccountHandoverBlock key={account.parentUsername} account={account} />
          ))}
        </div>
      )}

      {pendingCsv && (
        <ColumnMappingDialog
          headers={pendingCsv.headers}
          detected={pendingCsv.detected}
          onConfirm={(mapping) => {
            const text = pendingCsv.text;
            setPendingCsv(null);
            start(() => runImport(text, mapping));
          }}
          onCancel={() => setPendingCsv(null)}
        />
      )}
    </div>
  );
}
