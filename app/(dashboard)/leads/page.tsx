import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { LeadsFilterBar } from "@/components/leads/filter-bar";
import { Button } from "@/components/ui/button";
import { EnrichButton } from "@/components/leads/enrich-button";
import { AddLeadButton } from "@/components/leads/add-lead-button";
import { ColumnVisibility } from "@/components/leads/column-visibility";
import { SendEmailButton } from "@/components/leads/send-email-button";
import { ProcessButton } from "@/components/leads/process-button";
import { HeaderWithTip } from "@/components/ui/info-tip";
import { SourceBadge } from "@/components/leads/source-badge";
import { AnalyzeProvider } from "@/components/leads/analyze-context";
import { SelectionProvider, SelectAllCheckbox, LeadCheckbox, BulkDeleteBar } from "@/components/leads/selection";
import { formatNumber, formatPct, scoreColor } from "@/lib/utils";
import { buildKeywordOr } from "@/lib/leads/keyword-filter";
import { statusLabel } from "@/lib/labels";
import { ChevronLeft, ChevronRight, ExternalLink, Youtube, Linkedin } from "lucide-react";
import { LeadsActionsMenu } from "@/components/leads/actions-menu";
import { LeadsSearchBar } from "@/components/leads/search-bar";
import { ProgramNameCell } from "@/components/leads/program-name-cell";
import { DoubleClickRow } from "@/components/leads/double-click-row";
import { LeadEditDialog } from "@/components/leads/lead-edit-dialog";

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
  funnel_platform?: string;
  has_funnel?: string;
  has_email?: string;
  has_linkedin?: string;
  has_youtube?: string;
  has_outreach?: string;
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
    if (sp.search) q = q.or(`username.ilike.%${sp.search}%,full_name.ilike.%${sp.search}%`);
    if (sp.status && sp.status !== "all") q = q.eq("status", sp.status);
    if (sp.niche) q = q.ilike("niche", `%${sp.niche}%`);
    if (sp.business_model) q = q.eq("business_model", sp.business_model);
    if (sp.min_followers) q = q.gte("followers", Number(sp.min_followers));
    if (sp.max_followers) q = q.lte("followers", Number(sp.max_followers));
    if (sp.min_engagement) q = q.gte("engagement_rate", Number(sp.min_engagement) / 100);
    if (sp.min_reels_30d && !safe) q = q.gte("reels_last_30_days", Number(sp.min_reels_30d));
    if (sp.min_score) q = q.gte("overall_score", Number(sp.min_score));
    if (sp.funnel_platform) q = q.eq("funnel_platform", sp.funnel_platform);
    if (sp.has_funnel === "yes") q = q.not("funnel_program_name", "is", null);
    if (sp.has_funnel === "no") q = q.is("funnel_program_name", null);
    if (sp.has_email === "yes") q = q.not("email", "is", null);
    if (sp.has_email === "no") q = q.is("email", null);
    if (sp.has_linkedin === "yes") q = q.not("linkedin_url", "is", null);
    if (sp.has_linkedin === "no") q = q.is("linkedin_url", null);
    if (sp.has_youtube === "yes") q = q.not("youtube_url", "is", null);
    if (sp.has_youtube === "no") q = q.is("youtube_url", null);
    if (sp.has_outreach === "yes") q = q.gt("outreach_count", 0);
    if (sp.has_outreach === "no") q = q.eq("outreach_count", 0);

    if (sortStr === "uncontacted_score") {
      // Not contacted first (outreach_count = 0 / null), then score desc within each group
      q = q.order("outreach_count", { ascending: true, nullsFirst: true });
      q = q.order("overall_score", { ascending: false, nullsFirst: false });
    } else {
      const [col, dir] = sortStr.split(".");
      q = q.order(col, { ascending: dir === "asc", nullsFirst: false });
    }
    return q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  };

  const sort = sp.sort ?? "uncontacted_score";

  // Fire all independent queries in parallel — previously sequential, causing ~400-800ms of
  // unnecessary wait per page load.
  const [
    primary,
    { data: seeds },
    { data: seedCounts },
    { count: missingProgramNames },
    { count: scoreableCount },
    { count: pendingCount },
    { count: rejectedWithScore },
    { count: backfillCount },
    { count: qualifiedFunnelCount },
    { count: bouncedCount },
    { count: noEmailCount },
  ] = await Promise.all([
    buildQuery(sort, false),
    sb.from("seeds").select("id, username"),
    sb.from("leads").select("source_seed_id").not("source_seed_id", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "qualified").not("email", "is", null)
      .is("funnel_program_name", null).not("external_link", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .not("bio", "is", null).in("status", ["qualified", "review"]),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "pending").not("followers", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "rejected").not("overall_score", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .is("followers", null).or("backfill_error.is.null,backfill_error.eq.apify_exhausted")
      .neq("status", "rejected"),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "qualified").not("external_link", "is", null),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("email_status", "bounced"),
    sb.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "qualified").is("email", null),
  ]);

  const seedMap = new Map((seeds ?? []).map((s) => [s.id, s.username]));
  const countMap = new Map<string, number>();
  for (const row of seedCounts ?? []) {
    if (row.source_seed_id) countMap.set(row.source_seed_id, (countMap.get(row.source_seed_id) ?? 0) + 1);
  }

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

  return (
    <div className="p-6 space-y-6">
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
            missingProgramNames={missingProgramNames ?? 0}
            backfillCount={backfillCount ?? 0}
            qualifiedFunnelCount={qualifiedFunnelCount ?? 0}
            bouncedCount={bouncedCount ?? 0}
            noEmailCount={noEmailCount ?? 0}
            exportHref={exportHref}
          />
        </div>
      </div>

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
                <TableHead data-col="offer">
                  <HeaderWithTip label="Offer" tip="The product, program, or sales page found at the link in their bio." />
                </TableHead>
                <TableHead data-col="youtube">YouTube</TableHead>
                <TableHead data-col="linkedin">LinkedIn</TableHead>
                <TableHead data-col="email">Email</TableHead>
                <TableHead data-col="outreach">Outreach</TableHead>
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
                    email: l.email ?? null,
                    niche: l.niche ?? null,
                    bio: l.bio ?? null,
                    external_link: l.external_link ?? null,
                    funnel_program_name: l.funnel_program_name ?? null,
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
                      sourceUsername={l.source_seed_id ? (seedMap.get(l.source_seed_id) ?? null) : null}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" data-col="source">
                    {l.source_seed_id && seedMap.get(l.source_seed_id) ? (
                      <SourceBadge
                        username={seedMap.get(l.source_seed_id)!}
                        count={countMap.get(l.source_seed_id) ?? 0}
                      />
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" data-col="level">{l.crawl_depth}</TableCell>
                  <TableCell className="text-xs" data-col="offer">
                    <ProgramNameCell
                      leadId={l.id}
                      initial={l.funnel_program_name ?? null}
                      platform={l.funnel_platform ?? null}
                    />
                  </TableCell>
                  <TableCell data-col="youtube">
                    {l.youtube_url ? (
                      <a
                        href={l.youtube_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex"
                        title={l.youtube_url}
                        aria-label={`Open @${l.username}'s YouTube channel`}
                      >
                        <Youtube className="h-4 w-4" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell data-col="linkedin">
                    {l.linkedin_url ? (
                      <a
                        href={l.linkedin_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex"
                        title={l.linkedin_url}
                        aria-label={`Open @${l.username}'s LinkedIn profile`}
                      >
                        <Linkedin className="h-4 w-4" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell data-col="email">
                    <EnrichButton
                      leadId={l.id}
                      initialEmail={l.email ?? null}
                      initialStatus={l.email_status ?? null}
                      initialError={l.enrichment_error ?? null}
                    />
                  </TableCell>
                  <TableCell data-col="outreach">
                    <SendEmailButton
                      leadId={l.id}
                      hasEmail={!!l.email}
                      outreachCount={l.outreach_count ?? 0}
                    />
                  </TableCell>
                </DoubleClickRow>
              ))}
              {(leads ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={17} className="text-center text-sm text-muted-foreground py-8">
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
  );
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
