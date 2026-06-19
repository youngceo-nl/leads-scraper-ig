"use client";
import { useState, useTransition, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExternalLink, RefreshCw, Loader2, AlertCircle, Pencil, Check, X } from "lucide-react";
import { enrichFunnel, saveProgramName } from "@/app/actions/funnel";
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
  const [savePending, startSave] = useTransition();
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const startEdit = () => {
    setDraft(data.funnel_program_name ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const cancelEdit = () => setEditing(false);

  const commitEdit = () => {
    startSave(async () => {
      const r = await saveProgramName(leadId, draft);
      if (r.ok) {
        setData((d) => ({ ...d, funnel_program_name: draft.trim() || null }));
        setEditing(false);
      } else {
        setError(r.error ?? "save failed");
      }
    });
  };

  const hasFunnel = !!(data.funnel_program_name || data.funnel_url);
  const noLink = !initial.external_link;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Offer</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={startEdit}
            title="Enter program name manually"
          >
            <Pencil className="h-3.5 w-3.5 mr-1" />
            Edit
          </Button>
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
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {noLink && !editing && <p className="text-muted-foreground">No link in this account&apos;s bio — nothing to look up.</p>}

        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") cancelEdit();
              }}
              placeholder="e.g. 6-Week Coaching Program"
              className="h-8 text-sm"
            />
            <Button size="sm" variant="ghost" onClick={commitEdit} disabled={savePending} title="Save">
              {savePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-green-600" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit} title="Cancel">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            {!hasFunnel && !data.funnel_extraction_error && (
              <p className="text-muted-foreground">
                Not looked up yet.{" "}
                <button type="button" className="underline hover:text-foreground" onClick={startEdit}>
                  Enter manually
                </button>
              </p>
            )}

            {data.funnel_program_name && (
              <div>
                <div className="font-medium text-base">{data.funnel_program_name}</div>
                {data.funnel_offer_summary && (
                  <p className="text-muted-foreground mt-1">{data.funnel_offer_summary}</p>
                )}
              </div>
            )}
          </>
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
