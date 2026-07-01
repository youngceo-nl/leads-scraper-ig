"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { sendFollowup, sendFollowupBatchAction } from "@/app/actions/outreach";
import type { FollowupPreview } from "@/lib/types";
import { scoreColor } from "@/lib/utils";

type CardStatus = "idle" | "pending" | "sent" | "error";

export function FollowupPreviewList({
  leads,
  intervalMinutes,
}: {
  leads: FollowupPreview[];
  intervalMinutes: number;
}) {
  const [bodies, setBodies] = useState<Record<string, string>>(() =>
    Object.fromEntries(leads.map((l) => [l.leadId, l.body]))
  );
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [batchPending, startBatch] = useTransition();
  const [batchDone, setBatchDone] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const router = useRouter();

  const unsent = leads.filter((l) => cardStatus[l.leadId] !== "sent");
  const totalHours = ((unsent.length - 1) * intervalMinutes) / 60;

  const handleSendOne = async (lead: FollowupPreview) => {
    setCardStatus((prev) => ({ ...prev, [lead.leadId]: "pending" }));
    setCardErrors((prev) => { const n = { ...prev }; delete n[lead.leadId]; return n; });
    const res = await sendFollowup({
      leadId: lead.leadId,
      to: lead.email,
      subject: lead.subject,
      body: bodies[lead.leadId] ?? lead.body,
      inReplyTo: lead.inReplyTo,
      threadId: lead.threadId,
    });
    if (res.ok) {
      setCardStatus((prev) => ({ ...prev, [lead.leadId]: "sent" }));
    } else {
      setCardStatus((prev) => ({ ...prev, [lead.leadId]: "error" }));
      setCardErrors((prev) => ({ ...prev, [lead.leadId]: res.error ?? "Failed to send" }));
    }
  };

  const handleSendBatch = () => {
    if (unsent.length === 0) return;
    if (
      !confirm(
        `Send follow-up to ${unsent.length} lead${unsent.length !== 1 ? "s" : ""} at ${intervalMinutes}-minute intervals?\n\nThis will take ~${totalHours.toFixed(1)} hours and cannot be stopped mid-batch.`
      )
    )
      return;

    setCardStatus((prev) => {
      const next = { ...prev };
      unsent.forEach((l) => { if (!next[l.leadId]) next[l.leadId] = "pending"; });
      return next;
    });

    startBatch(async () => {
      const payload = unsent.map((l) => ({
        id: l.leadId,
        to: l.email,
        subject: l.subject,
        body: bodies[l.leadId] ?? l.body,
        inReplyTo: l.inReplyTo,
        threadId: l.threadId,
      }));
      const res = await sendFollowupBatchAction({ leads: payload, intervalMinutes });
      if (!res.ok) {
        setCardStatus((prev) => {
          const next = { ...prev };
          unsent.forEach((l) => { if (next[l.leadId] === "pending") delete next[l.leadId]; });
          return next;
        });
        setBatchError(res.error ?? "Failed to start batch");
        return;
      }
      setBatchDone(true);
      router.refresh();
    });
  };

  if (batchDone) {
    return <p className="text-sm text-green-700 font-medium">Follow-up batch queued — check the activity tab for progress.</p>;
  }

  if (leads.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No leads ready for follow-up right now.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Follow-up queue</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {[
              `${unsent.length} ready`,
              leads.length - unsent.length > 0 ? `${leads.length - unsent.length} sent this session` : null,
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
        {unsent.length > 0 && (
          <div className="flex flex-col items-end gap-1">
            <Button onClick={handleSendBatch} disabled={batchPending}>
              {batchPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {batchPending ? "Queuing…" : `Send all ${unsent.length}`}
            </Button>
            {batchError && <p className="text-xs text-destructive">{batchError}</p>}
          </div>
        )}
      </div>

      {leads.map((lead, idx) => {
        const status = cardStatus[lead.leadId] ?? "idle";
        const isSent = status === "sent";
        const isPending = status === "pending";

        return (
          <Card key={lead.leadId} className={isSent ? "opacity-50" : undefined}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-muted-foreground tabular-nums w-5">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={`https://www.instagram.com/${lead.username}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline inline-flex items-center gap-1"
                    >
                      @{lead.username}
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </a>
                    <span className="text-muted-foreground text-sm">→ {lead.email}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge variant="outline" className={`text-xs ${scoreColor(lead.score)}`}>
                      {lead.score != null ? Number(lead.score).toFixed(1) : "—"}
                    </Badge>
                    {lead.niche && <span className="text-xs text-muted-foreground">{lead.niche}</span>}
                    <span className="text-xs text-muted-foreground font-mono">{lead.subject}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isSent ? (
                    <span className="text-xs text-green-700 font-medium flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4" /> Sent
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={isPending}
                      onClick={() => handleSendOne(lead)}
                    >
                      {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      {isPending ? "Sending…" : "Send"}
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {cardErrors[lead.leadId] && (
                <p className="text-xs text-destructive mb-2">{cardErrors[lead.leadId]}</p>
              )}
              <Textarea
                value={bodies[lead.leadId] ?? lead.body}
                onChange={(e) => setBodies((prev) => ({ ...prev, [lead.leadId]: e.target.value }))}
                className="font-mono text-xs leading-relaxed min-h-[80px] resize-y"
                disabled={isSent}
              />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
