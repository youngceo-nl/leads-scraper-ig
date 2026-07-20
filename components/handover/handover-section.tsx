"use client";

import { useRef, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Handshake, Upload } from "lucide-react";
import type { AccountHandover } from "@/lib/handover/overview";
import { AccountHandoverBlock } from "@/components/handover/account-handover-block";
import { applyEnrichmentGlobal } from "@/app/actions/handover";
import { Button } from "@/components/ui/button";

/**
 * The per-account handover blocks, collapsed by default so they never push the
 * leads table off screen as source accounts accumulate.
 */
export function HandoverSection({ accounts }: { accounts: AccountHandover[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!accounts.length) return null;

  const done = accounts.reduce((sum, a) => sum + a.done, 0);
  const total = accounts.reduce((sum, a) => sum + a.total, 0);
  const openBatches = accounts.filter((a) => a.openBatch).length;

  // One CSV can cover leads from several dispatched accounts at once — rows
  // are matched back to leads by username, so there's nothing per-account to
  // route here (see applyEnrichmentAll).
  const upload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      start(async () => {
        setMessage(null);
        const result = await applyEnrichmentGlobal(text);
        if (!result.ok) {
          setMessage(`Error: ${result.error ?? "could not import"}`);
          return;
        }
        const parts = [`${result.withEmail} email${result.withEmail === 1 ? "" : "s"} found`];
        if (result.withoutEmail) parts.push(`${result.withoutEmail} with none`);
        if (result.skipped) parts.push(`${result.skipped} row(s) skipped (no match)`);
        if (result.closedBatches) {
          parts.push(`${result.closedBatches} batch${result.closedBatches === 1 ? "" : "es"} closed`);
        }
        setMessage(parts.join(", ") + ".");
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
            {accounts.length} account{accounts.length === 1 ? "" : "s"} · {done}/{total} enriched
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
    </div>
  );
}
