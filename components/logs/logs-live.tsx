"use client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LiveStatus } from "@/components/ui/live-status";
import { formatDistanceToNow } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { actionLabel, actionIsPositive } from "@/lib/labels";

type CrawlLog = {
  id: string;
  action: string;
  profile_username: string;
  depth: number;
  detail: string | null;
  created_at: string;
};

type ErrorLog = {
  id: string;
  context: string;
  error_message: string;
  created_at: string;
};

export function LogsLive({
  initialCrawl,
  initialErrors,
}: {
  initialCrawl: CrawlLog[];
  initialErrors: ErrorLog[];
}) {
  const [crawl, setCrawl] = useState<CrawlLog[]>(initialCrawl);
  const [errors, setErrors] = useState<ErrorLog[]>(initialErrors);

  // Active = there's been a crawl event in the last ~30s.
  const newest = crawl[0]?.created_at;
  const active = newest ? Date.now() - new Date(newest).getTime() < 30_000 : false;

  useEffect(() => {
    const sb = createClient();
    let cancelled = false;

    const tick = async () => {
      const [{ data: c }, { data: e }] = await Promise.all([
        sb.from("crawl_logs").select("*").order("created_at", { ascending: false }).limit(200),
        sb.from("error_logs").select("*").order("created_at", { ascending: false }).limit(100),
      ]);
      if (cancelled) return;
      if (c) setCrawl(c as CrawlLog[]);
      if (e) setErrors(e as ErrorLog[]);
    };

    const interval = active ? 2500 : 10000;
    const id = setInterval(tick, interval);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  return (
    <>
      <div className="flex items-center justify-end">
        <LiveStatus active={active} />
      </div>

      <Card>
        <CardHeader><CardTitle>Problems ({errors.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          {errors.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No problems — everything&apos;s running smoothly.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Where</TableHead><TableHead>What happened</TableHead><TableHead>When</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell><Badge variant="outline">{e.context}</Badge></TableCell>
                    <TableCell className="text-xs font-mono">{e.error_message}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Search activity</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>What happened</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crawl.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Badge variant={actionIsPositive(row.action) ? "outline" : "secondary"}>
                      {actionLabel(row.action)}
                    </Badge>
                  </TableCell>
                  <TableCell>@{row.profile_username}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.depth}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.detail}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
