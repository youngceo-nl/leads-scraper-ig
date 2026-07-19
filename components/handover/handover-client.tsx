"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Copy, Handshake, Upload } from "lucide-react";
import { applyEnrichment, claimBatch, closeBatch } from "@/app/actions/handover";
import type { HandoverLead } from "@/lib/handover/format";
import { BATCH_SIZE } from "@/lib/handover/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Batch = {
  id: string;
  createdAt: string;
  leads: (HandoverLead & { handover_enriched_at?: string | null; email?: string | null })[];
  enrichedCount: number;
  tsv: string;
};

export function HandoverClient({ poolCount, batch }: { poolCount: number; batch: Batch | null }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: (r: never) => string) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const result = await fn();
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      else if (onOk) setNotice(onOk(result as never));
    });

  const copy = async () => {
    if (!batch) return;
    await navigator.clipboard.writeText(batch.tsv);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const upload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      act(
        () => applyEnrichment(text),
        (r: { withEmail: number; withoutEmail: number }) =>
          `Imported ${r.withEmail} email${r.withEmail === 1 ? "" : "s"}` +
          (r.withoutEmail ? `, ${r.withoutEmail} row(s) had none.` : "."),
      );
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsText(file);
  };

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Handover</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Hand qualified leads without an email to Clay in batches of {BATCH_SIZE}, then bring the
          found emails back.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </div>
      )}

      {!batch ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Handshake className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              {poolCount > 0
                ? `${poolCount} qualified lead${poolCount === 1 ? "" : "s"} waiting for an email.`
                : "No qualified leads are waiting for an email."}
            </p>
            {poolCount > 0 && (
              <Button
                className="mt-4"
                disabled={pending}
                onClick={() => act(claimBatch)}
              >
                Claim {Math.min(poolCount, BATCH_SIZE)} leads
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div className="text-sm">
                <span className="font-medium">Open batch</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {batch.leads.length} leads · {batch.enrichedCount} returned
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={copy}>
                  {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                  {copied ? "Copied" : "Copy for Clay"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-4 w-4 mr-1" />
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
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    act(closeBatch, (r: { returnedToPool: number }) =>
                      r.returnedToPool
                        ? `Batch closed. ${r.returnedToPool} lead(s) went back to the pool.`
                        : "Batch closed.",
                    )
                  }
                >
                  Close batch
                </Button>
              </div>
            </div>

            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Username</th>
                  <th className="text-left font-medium px-4 py-2">Name</th>
                  <th className="text-left font-medium px-4 py-2">Niche</th>
                  <th className="text-left font-medium px-4 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {batch.leads.map((lead) => (
                  <tr key={lead.id} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{lead.username}</td>
                    <td className="px-4 py-2 text-muted-foreground">{lead.full_name ?? "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{lead.niche ?? "—"}</td>
                    <td className="px-4 py-2">
                      {lead.email ? (
                        <span className="text-emerald-600 dark:text-emerald-400">{lead.email}</span>
                      ) : lead.handover_enriched_at ? (
                        <Badge variant="secondary">No email found</Badge>
                      ) : (
                        <span className="text-muted-foreground">Pending</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
