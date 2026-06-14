import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrapeFromHistoryButton } from "@/components/seeds/add-from-history-button";
import { ChevronLeft } from "lucide-react";
import { getSettings } from "@/lib/config/settings";

export const dynamic = "force-dynamic";

export default async function SeedHistoryPage() {
  const sb = createAdminClient();
  const settings = await getSettings();

  // All distinct seed usernames ever used, with lead counts
  const { data: rows } = await sb
    .from("leads")
    .select("parent_username")
    .not("parent_username", "is", null);

  const countMap = new Map<string, number>();
  for (const r of rows ?? []) {
    if (r.parent_username) {
      countMap.set(r.parent_username, (countMap.get(r.parent_username) ?? 0) + 1);
    }
  }

  // Current seeds so we can show which are already active and get their IDs
  const { data: activeSeeds } = await sb.from("seeds").select("id, username, exhausted_providers");
  const activeSeedMap = new Map((activeSeeds ?? []).map((s) => [s.username, s]));

  const history = Array.from(countMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([username, leadCount]) => {
      const seed = activeSeedMap.get(username);
      return {
        username,
        leadCount,
        seedId: seed?.id,
        cookieExhausted: seed?.exhausted_providers?.includes("cookie") ?? false,
      };
    });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/seeds" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Source account history</h1>
          <p className="text-sm text-muted-foreground">{history.length} accounts ever used as a source</p>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>All source accounts</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Leads found</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                    No source accounts used yet.
                  </TableCell>
                </TableRow>
              )}
              {history.map((row) => (
                <TableRow key={row.username}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <a
                        href={`https://www.instagram.com/${row.username}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        @{row.username}
                      </a>
                      {row.seedId && <span className="text-xs text-green-600 font-medium">Active</span>}
                      {row.cookieExhausted && (
                        <span className="text-xs text-amber-600 font-medium">Cookie exhausted</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.leadCount}</TableCell>
                  <TableCell className="text-right">
                    <ScrapeFromHistoryButton username={row.username} seedId={row.seedId} defaultLimit={settings.max_profiles_per_account} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
