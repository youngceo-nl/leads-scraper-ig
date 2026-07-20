"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { claimBatch, closeBatch } from "@/app/actions/handover";
import { BATCH_SIZE } from "@/lib/handover/format";
import { UNATTRIBUTED, type AccountHandover } from "@/lib/handover/overview";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function AccountHandoverBlock({ account }: { account: AccountHandover }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  const { parentUsername, username, total, done, openBatch, poolLeads, poolMore } = account;
  const remaining = total - done;

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Claim opens the batch server-side, then immediately copies its handles —
  // one click covers both "set this batch aside" and "put it on the
  // clipboard", so there's nothing extra to do before pasting into Clay.
  const claimAndCopy = () =>
    start(async () => {
      setError(null);
      setNotice(null);
      const result = await claimBatch(parentUsername);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      await copyToClipboard(result.copyText);
    });

  const handleClose = () =>
    start(async () => {
      setError(null);
      setNotice(null);
      const result = await closeBatch(parentUsername);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      setNotice(
        result.returnedToPool
          ? `Batch closed. ${result.returnedToPool} lead(s) went back to the pool.`
          : "Batch closed.",
      );
    });

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">
              {parentUsername === UNATTRIBUTED ? username : `@${username}`}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {done}/{total} enriched
            </span>
            {openBatch && <Badge variant="secondary" className="text-[10px]">batch open</Badge>}
          </div>
          <div className="mt-1.5 h-1 w-full max-w-xs rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: total ? `${(done / total) * 100}%` : "0%" }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {!openBatch ? (
            remaining === 0 ? (
              // Scraped, but nothing qualified without an email. Say so rather
              // than offering a dead "Batch 0" button.
              <span className="text-xs text-muted-foreground pr-1">
                {total === 0 ? "no leads to enrich" : "all handed over"}
              </span>
            ) : (
              <Button size="sm" variant="outline" disabled={pending} onClick={claimAndCopy}>
                {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : null}
                {copied ? "Copied" : `Batch ${Math.min(remaining, BATCH_SIZE)}`}
              </Button>
            )
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(openBatch.copyText)}>
                {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                {copied ? "Copied" : "Copy again"}
              </Button>
              <Button size="sm" disabled={pending} onClick={handleClose}>
                Close
              </Button>
            </>
          )}

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="p-1 rounded hover:bg-accent"
            aria-label={open ? "Hide leads" : "Show leads"}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
      {notice && <p className="px-3 pb-2 text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}

      {open && (
        <div className="border-t">
          {openBatch && (
            <div>
              <p className="px-3 pt-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                In this batch
              </p>
              <table className="w-full text-xs">
                <tbody>
                  {openBatch.leads.map((lead) => (
                    <tr key={lead.id} className="border-b last:border-0">
                      <td className="px-3 py-1.5 font-medium">{lead.username}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{lead.full_name ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        {lead.email ? (
                          <span className="text-emerald-600 dark:text-emerald-400">{lead.email}</span>
                        ) : lead.handover_enriched_at ? (
                          <span className="text-muted-foreground">no email found</span>
                        ) : (
                          <span className="text-muted-foreground">pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Preview only — no actions here, just what's waiting in the pool. */}
          <div>
            <p className="px-3 pt-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Waiting in pool
            </p>
            {poolLeads.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Nothing waiting.</p>
            ) : (
              <ul className="divide-y">
                {poolLeads.map((lead) => (
                  <li key={lead.username} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="font-medium shrink-0">@{lead.username}</span>
                    <span className="text-muted-foreground truncate">{lead.full_name ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
            {poolMore > 0 && (
              <p className="px-3 py-1.5 text-[11px] text-muted-foreground">+{poolMore} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
