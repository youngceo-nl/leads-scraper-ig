"use client";
import { useState, useTransition } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { unmarkBadLead } from "@/app/actions/leads";
import { BAD_LEAD_LABELS, type BadLeadCategory } from "@/lib/leads/bad-lead";

export type RejectedLeadRow = {
  lead_id: string;
  username: string;
  category: string;
  note: string | null;
  created_at: string;
};

/** A human-corrected training collection — leads the AI qualified but shouldn't
 *  have (docs/bottlenecks/bottleneck02.md), for later teaching the system to
 *  stop allowing them. Cloned from components/seeds/bad-seeds-table.tsx. */
export function BadLeadsTable({ rows }: { rows: RejectedLeadRow[] }) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const visible = rows.filter((r) => !removed.has(r.lead_id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bad leads</CardTitle>
        <p className="text-sm text-muted-foreground">
          Leads the AI qualified but a human flagged as a bad fit — kept as a training set for
          teaching the scorer to stop allowing these.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Marked</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  No bad leads marked yet.
                </TableCell>
              </TableRow>
            )}
            {visible.map((row) => (
              <BadLeadRow key={row.lead_id} row={row} onRestored={() => setRemoved((s) => new Set(s).add(row.lead_id))} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BadLeadRow({ row, onRestored }: { row: RejectedLeadRow; onRestored: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const restore = () =>
    start(async () => {
      setError(null);
      const res = await unmarkBadLead(row.lead_id);
      if (!res.ok) { setError(res.error ?? "Could not restore"); return; }
      onRestored();
    });

  const label = BAD_LEAD_LABELS[row.category as BadLeadCategory] ?? row.category;

  return (
    <TableRow>
      <TableCell className="font-medium">@{row.username}</TableCell>
      <TableCell className="text-muted-foreground">{label}</TableCell>
      <TableCell className="text-muted-foreground max-w-xs truncate" title={row.note ?? undefined}>
        {row.note ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {new Date(row.created_at).toLocaleDateString()}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="ghost" disabled={pending} onClick={restore}>
          Restore
        </Button>
        {error && <span className="text-xs text-destructive ml-2">{error}</span>}
      </TableCell>
    </TableRow>
  );
}
