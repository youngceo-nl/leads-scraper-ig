import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { formatNumber, formatPct, scoreColor } from "@/lib/utils";
import { actionLabel, statusLabel } from "@/lib/labels";
import type { Lead, RecentPost } from "@/lib/types";
import { NotesSection } from "@/components/leads/notes-section";
import { EnrichButton } from "@/components/leads/enrich-button";
import { SendEmailButton } from "@/components/leads/send-email-button";
import { FunnelCard } from "@/components/leads/funnel-card";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const sb = createAdminClient();

  const { data: lead } = await sb.from("leads").select("*").eq("username", username.toLowerCase()).single();
  if (!lead) notFound();

  const [{ data: notes }, { data: path }, { data: replies }] = await Promise.all([
    sb.from("lead_notes").select("*").eq("lead_id", lead.id).order("created_at", { ascending: false }),
    sb
      .from("crawl_logs")
      .select("*")
      .eq("profile_username", username.toLowerCase())
      .order("created_at", { ascending: true })
      .limit(50),
    sb
      .from("inbox_messages")
      .select("id, from_name, from_email, subject, body_text, snippet, received_at")
      .eq("lead_id", lead.id)
      .order("received_at", { ascending: false }),
  ]);

  const l = lead as Lead;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm"><Link href="/leads"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link></Button>
      </div>

      <header className="flex items-start gap-6">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">@{l.username}</h1>
            {l.is_verified && <Badge>verified</Badge>}
            <StatusPill status={l.status} />
          </div>
          {l.full_name && <p className="text-muted-foreground">{l.full_name}</p>}
          {l.bio && <p className="mt-2 whitespace-pre-wrap text-sm">{l.bio}</p>}
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <a href={l.profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              <ExternalLink className="h-3 w-3" /> Instagram
            </a>
            {l.external_link && (
              <a href={l.external_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                <ExternalLink className="h-3 w-3" /> {l.external_link}
              </a>
            )}
          </div>
        </div>

        {l.status !== "rejected" && (
          <div className="text-right">
            <div className={`inline-block px-4 py-2 rounded-md text-3xl font-semibold ${scoreColor(l.overall_score)}`}>
              {l.overall_score != null ? Number(l.overall_score).toFixed(1) : "—"}
            </div>
            <p className="text-xs text-muted-foreground mt-1">overall score</p>
          </div>
        )}
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Contact</CardTitle>
          <div className="flex items-center gap-2">
            <EnrichButton leadId={l.id} initialEmail={l.email ?? null} initialStatus={l.email_status ?? null} />
            <SendEmailButton leadId={l.id} hasEmail={!!l.email} outreachCount={l.outreach_count ?? 0} />
          </div>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {l.email ? (
            <div className="flex items-center gap-3">
              <a className="font-medium hover:underline" href={`mailto:${l.email}`}>{l.email}</a>
              {l.email_status && <Badge variant="outline">{l.email_status}</Badge>}
              {l.email_provider && <span className="text-xs text-muted-foreground">via {l.email_provider}</span>}
            </div>
          ) : (
            <p className="text-muted-foreground">
              {l.email_status ? `Last attempt: ${l.email_status}` : "No email yet — click Find email to look one up."}
            </p>
          )}
          {l.linkedin_url && (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline">LinkedIn</Badge>
              <a className="hover:underline truncate" href={l.linkedin_url} target="_blank" rel="noreferrer">
                {l.linkedin_url}
              </a>
            </div>
          )}
          {!l.linkedin_url && l.linkedin_lookup_error && (
            <p className="text-xs text-muted-foreground">LinkedIn search: {l.linkedin_lookup_error}</p>
          )}
          {l.youtube_url && (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline">YouTube</Badge>
              <a className="hover:underline truncate" href={l.youtube_url} target="_blank" rel="noreferrer">
                {l.youtube_url}
              </a>
            </div>
          )}
          {!l.youtube_url && l.youtube_lookup_error && (
            <p className="text-xs text-muted-foreground">YouTube search: {l.youtube_lookup_error}</p>
          )}
          {l.enrichment_error && <p className="text-xs text-red-600 mt-1">{l.enrichment_error}</p>}
          {l.outreach_count > 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              ✉ {l.outreach_count} outreach email{l.outreach_count === 1 ? "" : "s"} sent
              {l.last_outreach_at && ` · last ${new Date(l.last_outreach_at).toLocaleDateString()}`}
            </p>
          )}
          {l.last_outreach_error && (
            <p className="text-xs text-red-600">Last send failed: {l.last_outreach_error}</p>
          )}
        </CardContent>
      </Card>

      <FunnelCard
        leadId={l.id}
        initial={{
          external_link: l.external_link,
          funnel_url: l.funnel_url,
          funnel_platform: l.funnel_platform,
          funnel_program_name: l.funnel_program_name,
          funnel_offer_summary: l.funnel_offer_summary,
          funnel_price: l.funnel_price,
          funnel_extracted_at: l.funnel_extracted_at,
          funnel_extraction_error: l.funnel_extraction_error,
        }}
      />

      {(replies ?? []).length > 0 && (
        <Card>
          <CardHeader><CardTitle>Replies ({(replies ?? []).length})</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(replies ?? []).map((r) => (
              <div key={r.id} className="rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{r.from_name || r.from_email || "Unknown sender"}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{new Date(r.received_at).toLocaleString()}</span>
                </div>
                {r.subject && <div className="text-sm text-muted-foreground mt-0.5">{r.subject}</div>}
                <p className="text-sm whitespace-pre-wrap break-words mt-2">{r.body_text?.trim() || r.snippet || "(empty message)"}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Followers" value={formatNumber(l.followers)} />
        <Stat label="Following" value={formatNumber(l.following)} />
        <Stat label="Posts (total)" value={formatNumber(l.posts)} />
        <Stat label="Reels (30d)" value={String(l.reels_last_30_days ?? "—")} />
        <Stat label="Avg likes" value={formatNumber(l.avg_likes ? Math.round(Number(l.avg_likes)) : null)} />
        <Stat label="Avg comments" value={formatNumber(l.avg_comments ? Math.round(Number(l.avg_comments)) : null)} />
        <Stat label="Avg views" value={formatNumber(l.avg_views ? Math.round(Number(l.avg_views)) : null)} />
        <Stat label="Engagement" value={formatPct(l.engagement_rate)} />
      </div>

      {l.status !== "rejected" ? (
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle>Score breakdown</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <ScoreRow label="Ideal-customer fit" value={l.icp_fit_score} />
              <ScoreRow label="Traction"     value={l.traction_score} />
              <ScoreRow label="Monetization" value={l.monetization_score} />
              <ScoreRow label="Activity"     value={l.activity_score} />
              <Separator />
              <ScoreRow label="Overall"      value={l.overall_score} bold />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Classification</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <KV k="Niche" v={l.niche} />
              <KV k="Business model" v={l.business_model} />
              <KV k="Offer" v={l.offer_type} />
              <KV k="Audience" v={l.audience_type} />
              <KV k="Recommended" v={l.recommended_action} />
              <KV k="Activity" v={l.activity_status?.replace("_", " ")} />
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader><CardTitle>Rejection reason</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {l.rejection_reason?.replace(/_/g, " ") ?? "—"}
          </CardContent>
        </Card>
      )}

      {l.status !== "rejected" && l.reason_for_score && (
        <Card>
          <CardHeader><CardTitle>Why it scored this way</CardTitle></CardHeader>
          <CardContent><p className="text-sm whitespace-pre-wrap">{l.reason_for_score}</p></CardContent>
        </Card>
      )}

      {l.recent_posts && l.recent_posts.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Recent captions</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {(l.recent_posts as RecentPost[]).slice(0, 12).map((p, i) => (
                <li key={i} className="text-sm border-l-2 pl-3">
                  <div className="text-xs text-muted-foreground mb-1">
                    ❤ {formatNumber(p.likes)} · 💬 {formatNumber(p.comments)}{p.views ? ` · ▶ ${formatNumber(p.views)}` : ""}
                    {p.taken_at && ` · ${new Date(p.taken_at).toLocaleDateString()}`}
                  </div>
                  <p className="whitespace-pre-wrap">{p.caption ?? <span className="italic text-muted-foreground">no caption</span>}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>How we found them</CardTitle></CardHeader>
        <CardContent>
          {l.parent_username ? (
            <p className="text-sm">
              Found through <Link className="underline" href={`/leads/${l.parent_username}`}>@{l.parent_username}</Link>
              {" "}— level <b>{l.crawl_depth}</b> from a source account.
            </p>
          ) : (
            <p className="text-sm">This is a source account (level {l.crawl_depth}).</p>
          )}
          {(path?.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {path!.map((row) => (
                <li key={row.id} className="flex gap-2">
                  <Badge variant="outline">{actionLabel(row.action)}</Badge>
                  <span className="text-muted-foreground">{row.detail}</span>
                  <span className="ml-auto text-muted-foreground">{new Date(row.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <NotesSection leadId={l.id} notes={(notes ?? []) as { id: string; body: string; created_at: string }[]} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
function StatusPill({ status }: { status: string }) {
  return <Badge variant={status === "qualified" ? "default" : status === "rejected" ? "destructive" : "secondary"}>{statusLabel(status)}</Badge>;
}
function KV({ k, v }: { k: string; v: string | null | undefined }) {
  return <div className="flex"><span className="w-32 text-muted-foreground">{k}</span><span className="font-medium">{v ?? "—"}</span></div>;
}
function ScoreRow({ label, value, bold }: { label: string; value: number | null; bold?: boolean }) {
  const v = value != null ? Number(value) : null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`flex-1 ${bold ? "font-semibold" : ""}`}>{label}</span>
      <div className="h-2 w-32 bg-muted rounded">
        <div className="h-full bg-primary rounded" style={{ width: `${Math.max(0, Math.min(100, ((v ?? 0) / 10) * 100))}%` }} />
      </div>
      <span className={`tabular-nums w-10 text-right ${bold ? "font-semibold" : ""}`}>{v != null ? v.toFixed(1) : "—"}</span>
    </div>
  );
}
