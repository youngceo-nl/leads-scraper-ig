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
import { Download, ChevronLeft, ChevronRight, ExternalLink, Youtube, Linkedin } from "lucide-react";

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
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const sb = createAdminClient();

  const { data: seeds } = await sb.from("seeds").select("id, username");
  const seedMap = new Map((seeds ?? []).map((s) => [s.id, s.username]));

  const { data: seedCounts } = await sb
    .from("leads")
    .select("source_seed_id")
    .not("source_seed_id", "is", null);
  const countMap = new Map<string, number>();
  for (const row of seedCounts ?? []) {
    if (row.source_seed_id) countMap.set(row.source_seed_id, (countMap.get(row.source_seed_id) ?? 0) + 1);
  }

  // Build the filtered + sorted query. In `safe` mode we drop anything that
  // depends on a column which may not exist yet (e.g. reels_last_30_days before
  // its migration is applied), so a stale sort/filter can never blank the table.
  const buildQuery = (sortStr: string, safe: boolean) => {
    let q = sb.from("leads").select("*", { count: "exact" });

    const keywordOr = buildKeywordOr(sp.q);
    if (keywordOr) q = q.or(keywordOr);
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

    const [col, dir] = sortStr.split(".");
    q = q.order(col, { ascending: dir === "asc", nullsFirst: false });
    return q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  };

  const sort = sp.sort ?? "created_at.desc";
  const primary = await buildQuery(sort, false);
  let leads = primary.data;
  let count = primary.count;
  if (primary.error) {
    // Most likely a column referenced by the sort/filter isn't migrated yet.
    // Fall back to a safe sort and drop the reels filter so the page still works.
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
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">{formatNumber(total)} total · page {page} of {totalPages}</p>
        </div>
        <div className="flex items-center gap-2">
          <AddLeadButton />
          <ColumnVisibility />
          <Button asChild variant="secondary">
            <a href={exportHref}><Download className="h-4 w-4 mr-2" /> Export CSV</a>
          </Button>
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
                <TableRow key={l.id} className="align-top">
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
                  <TableCell className="text-right tabular-nums" data-col="followers">{formatNumber(l.followers)}</TableCell>
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
                    {l.funnel_program_name ? (
                      <div className="space-y-0.5 max-w-[200px]">
                        <p className="font-medium truncate" title={l.funnel_program_name}>
                          {l.funnel_program_name}
                        </p>
                        {l.funnel_platform && (
                          <span className="text-[10px] text-muted-foreground">{l.funnel_platform}</span>
                        )}
                      </div>
                    ) : l.funnel_extraction_error ? (
                      <span className="text-[10px] text-red-600" title={l.funnel_extraction_error}>error</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
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
                </TableRow>
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
