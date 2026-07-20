import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { LeadsFilterBar } from "@/components/leads/filter-bar";
import { Button } from "@/components/ui/button";
import { AddLeadButton } from "@/components/leads/add-lead-button";
import { ColumnVisibility } from "@/components/leads/column-visibility";
import { ProcessButton } from "@/components/leads/process-button";
import { HeaderWithTip } from "@/components/ui/info-tip";
import { SourceBadge } from "@/components/leads/source-badge";
import { AnalyzeProvider } from "@/components/leads/analyze-context";
import { SelectionProvider, SelectAllCheckbox, LeadCheckbox, BulkDeleteBar } from "@/components/leads/selection";
import { formatNumber, formatPct, scoreColor } from "@/lib/utils";
import { buildKeywordOr } from "@/lib/leads/keyword-filter";
import { statusLabel } from "@/lib/labels";
import { ChevronLeft, ChevronRight, ExternalLink, AlertTriangle, Instagram } from "lucide-react";
import { LeadsActionsMenu } from "@/components/leads/actions-menu";
import { LeadsSearchBar } from "@/components/leads/search-bar";
import { DoubleClickRow } from "@/components/leads/double-click-row";
import { LeadEditDialog } from "@/components/leads/lead-edit-dialog";
import { getSettings, resolveApifyToken } from "@/lib/config/settings";
import { getAccountHandoverStats } from "@/lib/handover/overview";
import { HandoverSection } from "@/components/handover/handover-section";
import { DispatchLock } from "@/components/handover/dispatch-lock";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

type Search = {
  q?: string;
  status?: string;
  niche?: string;
  business_model?: string;
  min_followers?: string;
  max_followers?: string;
  min_engagement?: string;
  min_reels_30d?: string;
  min_score?: string;
  lead_source?: string;
  sort?: string;
  page?: string;
  search?: string;
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const sb = createAdminClient();

  // Build the filtered + sorted query. In `safe` mode we drop anything that
  // depends on a column which may not exist yet (e.g. reels_last_30_days before
  // its migration is applied), so a stale sort/filter can never blank the table.
  const buildQuery = (sortStr: string, safe: boolean) => {
    let q = sb.from("leads").select("*", { count: "exact" });

    const keywordOr = buildKeywordOr(sp.q);
    if (keywordOr) q = q.or(keywordOr);
    if (sp.search) q = q.or(`username.ilike.%${sp.search}%,full_name.ilike.%${sp.search}%,email.ilike.%${sp.search}%,email_v2.ilike.%${sp.search}%`);
    // When the search bar is active, skip all filter-bar conditions — intent is "find this specific lead"
    if (!sp.search) {
      if (sp.status && sp.status !== "all") q = q.eq("status", sp.status);
      if (sp.niche) q = q.ilike("niche", `%${sp.niche}%`);
      if (sp.business_model) q = q.eq("business_model", sp.business_model);
      if (sp.min_followers) q = q.gte("followers", Number(sp.min_followers));
      if (sp.max_followers) q = q.lte("followers", Number(sp.max_followers));
      if (sp.min_engagement) q = q.gte("engagement_rate", Number(sp.min_engagement) / 100);
      if (sp.min_reels_30d && !safe) q = q.gte("reels_last_30_days", Number(sp.min_reels_30d));
      if (sp.min_score) q = q.gte("overall_score", Number(sp.min_score));
      if (sp.lead_source === "crawl") q = q.is("lead_source", null);
      else if (sp.lead_source) q = q.eq("lead_source", sp.lead_source);
    }

    const [col, dir] = sortStr.split(".");
    q = q.order(col, { ascending: dir === "asc", nullsFirst: false });
    return q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  };

  const sort = sp.sort ?? "overall_score.desc";

  // Fire all independent queries in parallel — previously sequential, causing ~400-800ms of
  // unnecessary wait per page load.
  const [
    settings,
    primary,
    { data: seeds },
    { data: seedCounts },
    { count: scoreableCount },
    { count: pendingCount },
    { count: rejectedWithScore },
    { count: rejectedCount },
    { count: backfillCount },
    handoverAccounts,
  ] = await Promise.all([
    getSettings().catch(() => null),
    buildQuery(sort, false),
    sb.from("seeds").select("id, username"),
    // Aggregated server-side: an unbounded select truncates at 1000 rows,
    // which silently under-counted every account past the first page.
    sb.rpc("lead_counts_by_parent"),
    sb.from("leads").select("id", { count: "exact", head: true })
      .not("bio", "is", null).in("status", ["qualified", "review"]),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "pending").not("followers", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "rejected").not("overall_score", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "rejected").not("bio", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .is("followers", null).or("backfill_error.is.null,backfill_error.eq.apify_exhausted")
      .neq("status", "rejected"),
    // Empty rather than fatal: a missing handover table (migration not yet
    // applied) must not take the whole leads page down.
    getAccountHandoverStats().catch(() => []),
  ]);

  const seedMap = new Map((seeds ?? []).map((s) => [s.id, s.username]));
  // Counted by parent_username — the account whose following list produced the
  // lead. source_seed_id survives recursion into other accounts, so counting by
  // it credited @pierree with 1039 leads when only 462 are his followings.
  const countMap = new Map<string, number>(
    ((seedCounts ?? []) as { parent_username: string; total: number }[]).map((r) => [
      r.parent_username,
      r.total,
    ]),
  );

  let leads = primary.data;
  let count = primary.count;
  if (primary.error) {
    const safeSort = sort.startsWith("reels_last_30_days") ? "created_at.desc" : sort;
    const fallback = await buildQuery(safeSort, true);
    leads = fallback.data;
    count = fallback.count;
  }
  const allIds = (leads ?? []).map((l) => l.id);
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const exportHref = `/api/leads/export?${new URLSearchParams(sp as Record<string, string>).toString()}`;

  const igConfigured = !!(
    settings &&
    ((settings.instagram_accounts ?? []).length > 0 ||
      (settings.instagram_session_cookies ?? []).length > 0 ||
      settings.instagram_session_cookie)
  );

  // Apify covers following scrapes and backfill; the cookie is only a fallback.
  const apifyConfigured = !!(settings && resolveApifyToken(settings));

  const igStatus: "ok" | "unknown" | "missing" | "dead" = !igConfigured ? "missing"
    : settings?.ig_cookie_status === "dead" ? "dead"
    : settings?.ig_cookie_status === "live" ? "ok"
    : "unknown";

  return (
    <div className="relative">
      {/* absolute, not fixed — covers this page's content only, not the dashboard sidebar */}
      <DispatchLock />
      <div className="p-6 space-y-6">
      {/* Cookie warnings only matter when Apify can't cover the work. Apify is
          the standard provider for both following scrapes and backfill, so a
          dead cookie is not an error while a token is configured — the old
          "scraping will fail" banner was simply untrue. */}
      {!apifyConfigured && igStatus === "missing" && (
        <div className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Instagram className="h-4 w-4 shrink-0" />
          <span>No Apify token and no Instagram cookie — scraping is disabled. <a href="/settings#instagram" className="font-medium underline underline-offset-2">Fix in Settings</a></span>
        </div>
      )}
      {!apifyConfigured && igStatus === "dead" && (
        <div className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Instagram cookie is expired and no Apify token is set — scraping will fail. <a href="/settings#instagram" className="font-medium underline underline-offset-2">Fix in Settings</a></span>
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">{formatNumber(total)} total · page {page} of {totalPages}</p>
        </div>
        <LeadsSearchBar initial={sp.search} />
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <AddLeadButton />
          <ColumnVisibility />
          <LeadsActionsMenu
            pendingCount={pendingCount ?? 0}
            scoreableCount={scoreableCount ?? 0}
            rejectedWithScore={rejectedWithScore ?? 0}
            backfillCount={backfillCount ?? 0}
            rejectedCount={rejectedCount ?? 0}
            exportHref={exportHref}
            systemStatus={{ igStatus }}
          />
        </div>
      </div>

      <HandoverSection accounts={handoverAccounts} />

      <Card>
        <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
        <CardContent>
          <LeadsFilterBar initial={sp} />
        </CardContent>
      </Card>

      <SelectionProvider allIds={allIds}>
      <BulkDeleteBar />
      <Card>
        <CardContent className="p-0">
          <div className="leads-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"><SelectAllCheckbox /></TableHead>
                <TableHead className="w-[28%]" data-col="account">Account</TableHead>
                <TableHead className="w-[32%]" data-col="bio">Bio</TableHead>
                <TableHead data-col="niche">Niche</TableHead>
                <TableHead className="text-right" data-col="followers">Followers</TableHead>
                <TableHead className="text-right" data-col="engagement">
                  <HeaderWithTip label="Engagement" tip="Engagement rate — how active their audience is (likes + comments relative to follower count). Higher is better." />
                </TableHead>
                <TableHead className="text-right" data-col="reels">
                  <HeaderWithTip label="Reels (30d)" tip="How many reels this account posted in the last 30 days — the engagement signal." />
                </TableHead>
                <TableHead className="text-right" data-col="score">
                  <HeaderWithTip label="Score" tip="Overall fit score from 0–10, decided by AI. Higher means a better match for your ideal customer." />
                </TableHead>
                <TableHead data-col="status">Status</TableHead>
                <TableHead data-col="analyze">Analyze</TableHead>
                <TableHead data-col="source">Source</TableHead>
                <TableHead data-col="level">
                  <HeaderWithTip label="Level" tip="How far this account is from a source account. Level 0 is a source account, level 1 is someone they follow, and so on." />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnalyzeProvider>
              {(leads ?? []).map((l) => (
                <DoubleClickRow
                  key={l.id}
                  className="border-b transition-colors hover:bg-muted/50 align-top"
                  payload={{
                    leadId: l.id,
                    full_name: l.full_name ?? null,
                    niche: l.niche ?? null,
                    bio: l.bio ?? null,
                    external_link: l.external_link ?? null,
                    status: l.status ?? null,
                  }}
                >
                  <TableCell className="pt-3"><LeadCheckbox id={l.id} /></TableCell>
                  <TableCell data-col="account">
                    <div className="flex items-center gap-1.5">
                      <Link href={`/leads/${l.username}`} className="font-medium hover:underline">@{l.username}</Link>
                      <a
                        href={l.profile_url ?? `https://www.instagram.com/${l.username}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="Open on Instagram"
                        aria-label={`Open @${l.username} on Instagram`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                    {l.full_name && <div className="text-xs text-muted-foreground">{l.full_name}</div>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" data-col="bio">
                    {l.bio ? (
                      <p className="line-clamp-3 whitespace-pre-wrap" title={l.bio}>{l.bio}</p>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs" data-col="niche">{l.niche ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums" data-col="followers">
                    {l.backfill_error
                      ? <span title={`Scraping blocked: ${l.backfill_error}`} className="text-amber-500 text-xs">blocked</span>
                      : formatNumber(l.followers)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-col="engagement">{formatPct(l.engagement_rate)}</TableCell>
                  <TableCell className="text-right tabular-nums" data-col="reels">{l.reels_last_30_days ?? "—"}</TableCell>
                  <TableCell className="text-right" data-col="score">
                    <span className={`inline-block px-2 py-0.5 rounded font-semibold tabular-nums ${scoreColor(l.overall_score)}`}>
                      {l.overall_score != null ? Number(l.overall_score).toFixed(1) : "—"}
                    </span>
                  </TableCell>
                  <TableCell data-col="status"><StatusBadge status={l.status} /></TableCell>
                  <TableCell data-col="analyze">
                    <ProcessButton
                      leadId={l.id}
                      status={l.status}
                      sourceSeedId={l.source_seed_id ?? null}
                      sourceUsername={l.parent_username ?? (l.source_seed_id ? (seedMap.get(l.source_seed_id) ?? null) : null)}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" data-col="source">
                    {l.lead_source ? (
                      <Badge variant="outline" className="text-xs">{leadSourceLabel(l.lead_source)}</Badge>
                    ) : l.parent_username ? (
                      <SourceBadge
                        username={l.parent_username}
                        count={countMap.get(l.parent_username) ?? 0}
                      />
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" data-col="level">{l.crawl_depth}</TableCell>
                </DoubleClickRow>
              ))}
              {(leads ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-sm text-muted-foreground py-8">
                    No leads match these filters.
                  </TableCell>
                </TableRow>
              )}
              </AnalyzeProvider>
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
      </SelectionProvider>

      <Pagination page={page} totalPages={totalPages} sp={sp} />
      <LeadEditDialog />
      </div>
    </div>
  );
}

function leadSourceLabel(source: string): string {
  if (source === "telegram") return "Telegram";
  if (source === "manual_ui") return "Manual";
  if (source === "manual_api") return "API";
  return source;
}

function StatusBadge({ status }: { status: string }) {
  const v: "default" | "secondary" | "destructive" | "outline" =
    status === "qualified" ? "default" :
    status === "review" ? "secondary" :
    status === "rejected" ? "destructive" : "outline";
  return <Badge variant={v}>{statusLabel(status)}</Badge>;
}

function Pagination({ page, totalPages, sp }: { page: number; totalPages: number; sp: Search }) {
  const make = (p: number) => {
    const params = new URLSearchParams(sp as Record<string, string>);
    params.set("page", String(p));
    return `?${params.toString()}`;
  };
  return (
    <div className="flex items-center justify-end gap-2">
      <Button asChild variant="outline" size="sm" disabled={page <= 1}>
        <Link href={make(Math.max(1, page - 1))}><ChevronLeft className="h-4 w-4" /></Link>
      </Button>
      <span className="text-sm tabular-nums">{page} / {totalPages}</span>
      <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
        <Link href={make(Math.min(totalPages, page + 1))}><ChevronRight className="h-4 w-4" /></Link>
      </Button>
    </div>
  );
}
