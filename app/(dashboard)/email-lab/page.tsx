import Link from "next/link";
import { ExternalLink, Youtube, Check, X } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EnrichV2Button } from "@/components/leads/enrich-v2-button";
import { formatNumber, scoreColor } from "@/lib/utils";
import type { Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  ig_bio: "IG bio",
  youtube_free: "YT About (public)",
  youtube_capsolver: "YT About (gated)",
  youtube: "YouTube",
  ig_mobile: "IG mobile button",
  instagram_bio: "IG bio",
};

function providerLabel(provider: string | null): string {
  if (!provider) return "";
  return PROVIDER_LABELS[provider] ?? provider;
}

export default async function EmailLabPage() {
  const sb = createAdminClient();

  const { data: leads, count } = await sb
    .from("leads")
    .select("*", { count: "exact" })
    .eq("status", "qualified")
    .order("overall_score", { ascending: false })
    .limit(200);

  const rows = (leads ?? []) as Lead[];

  const enrichedV2Count = rows.filter((l) => l.email_v2_enriched_at).length;
  const v2HitCount = rows.filter((l) => l.email_v2 && l.email_v2_status === "found").length;
  const v1HitCount = rows.filter((l) => l.email && l.email_status === "found").length;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email Lab</h1>
        <p className="text-sm text-muted-foreground max-w-2xl mt-1">
          Alternative enrichment flow: IG bio → YouTube About → Instagram mobile email button.
          Results land in separate columns so you can compare hit rates with the main pipeline.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xl font-bold tabular-nums">{v1HitCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">V1 emails found</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xl font-bold tabular-nums">{v2HitCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">V2 emails found</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xl font-bold tabular-nums">{enrichedV2Count} / {formatNumber(count ?? rows.length)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">V2 runs completed</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Qualified leads — top {formatNumber(count ?? rows.length)}</CardTitle>
          <CardDescription>
            Click <strong>Enrich V2</strong> on any row to run the new pipeline. Results appear immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {/* Header row */}
          <div className="grid grid-cols-[40px_1fr_220px_220px_160px] gap-x-4 px-6 py-2 border-b bg-muted/40 text-xs font-medium text-muted-foreground sticky top-0">
            <span>Score</span>
            <span>Lead</span>
            <span>V1 email</span>
            <span>V2 email</span>
            <span>V2 action</span>
          </div>

          <div className="divide-y">
            {rows.map((lead) => (
              <div
                key={lead.id}
                className="grid grid-cols-[40px_1fr_220px_220px_160px] gap-x-4 items-start px-6 py-3 hover:bg-muted/20 transition-colors"
              >
                {/* Score */}
                <div className="mt-0.5">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums ${scoreColor(lead.overall_score)}`}>
                    {lead.overall_score != null ? Number(lead.overall_score).toFixed(1) : "—"}
                  </span>
                </div>

                {/* Identity */}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <a
                      href={lead.profile_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-sm hover:underline flex items-center gap-1"
                    >
                      @{lead.username}
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </a>
                    {lead.niche && (
                      <span className="text-xs bg-muted rounded-full px-2 py-0.5 text-muted-foreground">
                        {lead.niche}
                      </span>
                    )}
                  </div>
                  {lead.full_name && (
                    <p className="text-xs text-muted-foreground mt-0.5">{lead.full_name}</p>
                  )}
                  {lead.youtube_url && (
                    <a
                      href={lead.youtube_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground mt-0.5"
                    >
                      <Youtube className="h-3 w-3 text-red-500" /> YouTube
                    </a>
                  )}
                </div>

                {/* V1 email */}
                <div className="text-xs pt-0.5">
                  {lead.email ? (
                    <div className="space-y-0.5">
                      <a href={`mailto:${lead.email}`} className="flex items-center gap-1 hover:underline text-green-700">
                        <Check className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{lead.email}</span>
                      </a>
                      {lead.email_provider && (
                        <span className="text-[10px] text-muted-foreground">{providerLabel(lead.email_provider)}</span>
                      )}
                    </div>
                  ) : lead.enriched_at ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <X className="h-3 w-3" /> not found
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>

                {/* V2 email */}
                <div className="text-xs pt-0.5">
                  {lead.email_v2 ? (
                    <div className="space-y-0.5">
                      <a href={`mailto:${lead.email_v2}`} className="flex items-center gap-1 hover:underline text-green-700">
                        <Check className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{lead.email_v2}</span>
                      </a>
                      {lead.email_v2_provider && (
                        <span className="text-[10px] text-muted-foreground">{providerLabel(lead.email_v2_provider)}</span>
                      )}
                    </div>
                  ) : lead.email_v2_enriched_at ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <X className="h-3 w-3" /> not found
                    </span>
                  ) : (
                    <span className="text-muted-foreground">not run</span>
                  )}
                </div>

                {/* V2 action */}
                <div>
                  <EnrichV2Button
                    leadId={lead.id}
                    initialEmail={lead.email_v2}
                    initialStatus={lead.email_v2_status}
                    initialError={lead.email_v2_error}
                  />
                </div>
              </div>
            ))}
          </div>

          {rows.length === 0 && (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No qualified leads yet.{" "}
              <Link href="/seeds" className="underline underline-offset-2">Add seeds</Link>{" "}
              to start scraping.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
