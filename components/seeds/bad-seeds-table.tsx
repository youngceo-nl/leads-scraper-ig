"use client";
import { useState, useTransition } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { unmarkBadSeed } from "@/app/actions/seeds";

export type RejectedSeedRow = { username: string; reason: string | null; created_at: string };

export function BadSeedsTable({ rows }: { rows: RejectedSeedRow[] }) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const visible = rows.filter((r) => !removed.has(r.username));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bad seeds</CardTitle>
        <p className="text-sm text-muted-foreground">
          Accounts marked as bad seed candidates — kept as a training set, excluded from
          Recommended above.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Marked</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                  No bad seeds marked yet.
                </TableCell>
              </TableRow>
            )}
            {visible.map((row) => (
              <BadSeedRow key={row.username} row={row} onRestored={() => setRemoved((s) => new Set(s).add(row.username))} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BadSeedRow({ row, onRestored }: { row: RejectedSeedRow; onRestored: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const restore = () =>
    start(async () => {
      setError(null);
      const res = await unmarkBadSeed(row.username);
      if (!res.ok) { setError(res.error ?? "Could not restore"); return; }
      onRestored();
    });

  return (
    <TableRow>
      <TableCell className="font-medium">@{row.username}</TableCell>
      <TableCell className="text-muted-foreground">{row.reason ?? "—"}</TableCell>
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
