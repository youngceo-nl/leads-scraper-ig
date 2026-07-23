"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, Upload, X } from "lucide-react";
import { getDispatchState, applyEnrichmentGlobal, closeBatch } from "@/app/actions/handover";
import type { DispatchState } from "@/lib/handover/batch";
import { Button } from "@/components/ui/button";

const POLL_MS = 3000;

/**
 * Whole-leads-page lock while a batch is out with Clay. Mounted once from
 * leads/page.tsx inside a `relative` wrapper around the page content — this
 * renders `absolute inset-0` rather than `fixed inset-0` so it covers only
 * that content, not the dashboard sidebar.
 *
 * State is derived server-side from `handover_batches`/`leads` (see
 * getDispatchState), not held here — so the lock re-establishes correctly on
 * navigation/reload rather than depending on this component staying mounted.
 */
export function DispatchLock() {
  const [state, setState] = useState<DispatchState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getDispatchState());
    } catch {
      /* transient — keep the last known state rather than flashing unlocked */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (!state?.locked) return null;

  const copyAgain = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setMessage("Copied.");
  };

  const upload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      (async () => {
        setBusy(true);
        setMessage(null);
        const result = await applyEnrichmentGlobal(text);
        setBusy(false);
        if (!result.ok) {
          setMessage(`Error: ${result.error ?? "could not import"}`);
          return;
        }
        const parts = [`${result.withEmail} email${result.withEmail === 1 ? "" : "s"} found`];
        if (result.markedBad) parts.push(`${result.markedBad} marked bad`);
        if (result.skipped) parts.push(`${result.skipped} row(s) skipped (no match)`);
        setMessage(parts.join(", ") + ".");
        await refresh();
      })();
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsText(file);
  };

  const cancelDispatch = (parentUsername: string) => {
    setBusy(true);
    setMessage(null);
    (async () => {
      const result = await closeBatch(parentUsername);
      setBusy(false);
      if (!result.ok) {
        setMessage(`Error: ${result.error ?? "could not cancel"}`);
        return;
      }
      await refresh();
    })();
  };

  return (
    <div className="absolute inset-0 z-40">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-[1px]" aria-hidden="true" />
      <div className="relative flex items-start justify-center pt-20 px-4">
        <div className="w-full max-w-md rounded-lg border bg-background shadow-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <h2 className="font-semibold text-sm">Batch dispatched — page locked</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Leads are out with Clay. Paste them in there, then upload the enriched CSV to unlock —
            or cancel a batch to return its leads to the pool.
          </p>

          <div className="space-y-1.5">
            {state.batches.map((b) => (
              <div
                key={b.parentUsername}
                className="flex items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-xs"
              >
                <span className="font-medium truncate">@{b.parentUsername}</span>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {b.enriched}/{b.total}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => copyAgain(b.copyText)}>
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => cancelDispatch(b.parentUsername)}
                  >
                    <X className="h-3 w-3 mr-1" /> Cancel
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <Button size="sm" className="w-full" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5 mr-1.5" /> Upload enriched CSV
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

          {message && <p className="text-xs text-muted-foreground">{message}</p>}
        </div>
      </div>
    </div>
  );
}
