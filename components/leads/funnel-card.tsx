"use client";
import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, RefreshCw, Loader2, AlertCircle } from "lucide-react";
import { enrichFunnel } from "@/app/actions/funnel";
import { formatDistanceToNow } from "date-fns";

type Initial = {
  external_link: string | null;
  funnel_url: string | null;
  funnel_platform: string | null;
  funnel_program_name: string | null;
  funnel_offer_summary: string | null;
  funnel_price: string | null;
  funnel_extracted_at: string | null;
  funnel_extraction_error: string | null;
};

export function FunnelCard({ leadId, initial }: { leadId: string; initial: Initial }) {
  const [pending, start] = useTransition();
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    start(async () => {
      const r = await enrichFunnel(leadId);
      if (r.ok) {
        setData((d) => ({
          ...d,
          funnel_url: r.funnel_url ?? null,
          funnel_platform: r.funnel_platform ?? null,
          funnel_program_name: r.funnel_program_name ?? null,
          funnel_offer_summary: r.funnel_offer_summary ?? null,
          funnel_price: r.funnel_price ?? null,
          funnel_extracted_at: new Date().toISOString(),
          funnel_extraction_error: null,
        }));
      } else {
        setError(r.error ?? "unknown error");
      }
    });
  };

  const hasFunnel = !!(data.funnel_program_name || data.funnel_url);
  const noLink = !initial.external_link;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Offer</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={onClick}
          disabled={pending || noLink}
          title={noLink ? "This account has no link in their bio" : "Look up the offer behind their bio link"}
        >
          {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          {hasFunnel ? "Refresh" : "Find offer"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {noLink && <p className="text-muted-foreground">No link in this account&apos;s bio — nothing to look up.</p>}

        {!noLink && !hasFunnel && !data.funnel_extraction_error && (
          <p className="text-muted-foreground">Not looked up yet.</p>
        )}

        {data.funnel_program_name && (
          <div>
            <div className="font-medium text-base">{data.funnel_program_name}</div>
            {data.funnel_offer_summary && (
              <p className="text-muted-foreground mt-1">{data.funnel_offer_summary}</p>
            )}
          </div>
        )}

        <div className="flex items-center flex-wrap gap-2">
          {data.funnel_platform && <Badge variant="outline">{data.funnel_platform}</Badge>}
          {data.funnel_price && <Badge variant="secondary">{data.funnel_price}</Badge>}
          {data.funnel_url && (
            <a
              href={data.funnel_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs hover:underline truncate max-w-md"
            >
              <ExternalLink className="h-3 w-3" /> {data.funnel_url}
            </a>
          )}
        </div>

        {data.funnel_extracted_at && (
          <p className="text-xs text-muted-foreground">
            Last checked {formatDistanceToNow(new Date(data.funnel_extracted_at), { addSuffix: true })}
          </p>
        )}

        {(data.funnel_extraction_error || error) && (
          <p className="text-xs text-red-600 inline-flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {error ?? data.funnel_extraction_error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
