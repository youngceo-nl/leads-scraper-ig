"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, AlertCircle, CheckCircle2, RotateCcw, ExternalLink, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { sendOutreachBatch, sendOutreach } from "@/app/actions/outreach";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { scoreColor } from "@/lib/utils";

export type SendablePreview = {
  leadId: string;
  username: string;
  firstName: string;
  email: string;
  emailSource: string | null;
  score: number | null;
  status: string;
  niche: string | null;
  subject: string;
  body: string;
};

export type BlockedPreview = {
  leadId: string;
  username: string;
  blockReason: string;
};

export type AlreadySentPreview = {
  leadId: string;
  username: string;
  score: number | null;
  niche: string | null;
  email: string | null;
};

export type NeedsEmailPreview = {
  leadId: string;
  username: string;
  score: number | null;
  niche: string | null;
};

type EditState = { subject: string; body: string };
type CardStatus = "idle" | "pending" | "sent" | "error";

export function OutreachPreviewList({
  sendable,
  blocked,
  alreadySent,
  needsEmail,
  intervalMinutes,
  sentToday,
}: {
  sendable: SendablePreview[];
  blocked: BlockedPreview[];
  alreadySent: AlreadySentPreview[];
  needsEmail: NeedsEmailPreview[];
  intervalMinutes: number;
  sentToday: number;
}) {
  const [edits, setEdits] = useState<Record<string, EditState>>(() =>
    Object.fromEntries(sendable.map((p) => [p.leadId, { subject: p.subject, body: p.body }]))
  );
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [batchPending, startBatch] = useTransition();
  const [batchDone, setBatchDone] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const router = useRouter();

  const unsent = sendable.filter((p) => cardStatus[p.leadId] !== "sent");
  const totalHours = ((unsent.length - 1) * intervalMinutes) / 60;

  const handleSendOne = async (preview: SendablePreview) => {
    const edit = edits[preview.leadId] ?? { subject: preview.subject, body: preview.body };
    setCardStatus((prev) => ({ ...prev, [preview.leadId]: "pending" }));
    setCardErrors((prev) => { const n = { ...prev }; delete n[preview.leadId]; return n; });
    const res = await sendOutreach({ leadId: preview.leadId, to: preview.email, subject: edit.subject, body: edit.body });
    if (res.ok) {
      setCardStatus((prev) => ({ ...prev, [preview.leadId]: "sent" }));
    } else {
      setCardStatus((prev) => ({ ...prev, [preview.leadId]: "error" }));
      setCardErrors((prev) => ({ ...prev, [preview.leadId]: res.error ?? "Failed to send" }));
    }
  };

  const handleSendBatch = () => {
    if (unsent.length === 0) return;
    if (
      !confirm(
        `Send ${unsent.length} email${unsent.length !== 1 ? "s" : ""} at ${intervalMinutes}-minute intervals?\n\nThis will take ~${totalHours.toFixed(1)} hours and cannot be stopped mid-batch.`
      )
    )
      return;

    // Immediately lock all unsent cards so individual send buttons can't fire
    // while the batch is being queued or running in Inngest
    setCardStatus((prev) => {
      const next = { ...prev };
      unsent.forEach((p) => { if (!next[p.leadId]) next[p.leadId] = "pending"; });
      return next;
    });

    startBatch(async () => {
      const leads = unsent.map((p) => ({
        id: p.leadId,
        subject: edits[p.leadId]?.subject ?? p.subject,
        body: edits[p.leadId]?.body ?? p.body,
      }));
      const res = await sendOutreachBatch({ leads, intervalMinutes });
      if (!res.ok) {
        // Unlock cards on failure so user can retry
        setCardStatus((prev) => {
          const next = { ...prev };
          unsent.forEach((p) => { if (next[p.leadId] === "pending") delete next[p.leadId]; });
          return next;
        });
        setBatchError(res.error ?? "Failed to start batch");
        return;
      }
      setBatchDone(true);
      router.refresh();
    });
  };

  const resetEdit = (leadId: string, original: EditState) => {
    setEdits((prev) => ({ ...prev, [leadId]: original }));
  };

  if (batchDone) {
    return <p className="text-sm text-green-700 font-medium">Batch queued — check the activity tab for progress.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Outreach preview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {[
                  unsent.length > 0 ? `${unsent.length} ready` : (sendable.length === 0 ? "No leads ready to send" : null),
                  sendable.length - unsent.length > 0 ? `${sendable.length - unsent.length} sent this session` : null,
                  blocked.length > 0 ? `${blocked.length} blocked` : null,
                  alreadySent.length > 0 ? `${alreadySent.length} already contacted` : null,
                  needsEmail.length > 0 ? `${needsEmail.length} need email` : null,
                  sentToday > 0 ? `${sentToday} sent today` : null,
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

      {/* Blocked */}
      {blocked.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardHeader className="pb-2 pt-4">
            <p className="text-sm font-medium text-amber-800 flex items-center gap-1.5">
              <AlertCircle className="h-4 w-4" />
              {blocked.length} lead{blocked.length !== 1 ? "s" : ""} blocked
            </p>
            <p className="text-xs text-amber-700">These won&apos;t be sent — fix their name in the lead profile to include them.</p>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-1">
              {blocked.map(({ leadId, username, blockReason }) => (
                <li key={leadId} className="text-sm text-amber-800 flex items-center gap-2">
                  <span className="font-medium">@{username}</span>
                  <span className="text-amber-600">{blockReason}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Already sent */}
      {alreadySent.length > 0 && (
        <Card className="border-green-200 bg-green-50/40">
          <CardHeader className="pb-2 pt-4">
            <p className="text-sm font-medium text-green-800 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              {alreadySent.length} already contacted
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-1">
              {alreadySent.map(({ leadId, username, score, niche, email }) => (
                <li key={leadId} className="text-sm flex items-center gap-2 text-green-900">
                  <Badge variant="outline" className={`text-xs shrink-0 ${scoreColor(score)}`}>
                    {score != null ? score.toFixed(1) : "—"}
                  </Badge>
                  <a
                    href={`https://www.instagram.com/${username}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline inline-flex items-center gap-1"
                  >
                    @{username}
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </a>
                  {niche && <span className="text-xs text-green-700">{niche}</span>}
                  {email && <span className="text-xs text-muted-foreground ml-auto">{email}</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Needs email */}
      {needsEmail.length > 0 && (
        <Card className="border-slate-200 bg-slate-50/50">
          <CardHeader className="pb-2 pt-4">
            <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
              <Mail className="h-4 w-4" />
              {needsEmail.length} need{needsEmail.length === 1 ? "s" : ""} email enrichment
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-1">
              {needsEmail.map(({ leadId, username, score, niche }) => (
                <li key={leadId} className="text-sm flex items-center gap-2 text-slate-700">
                  <Badge variant="outline" className={`text-xs shrink-0 ${scoreColor(score)}`}>
                    {score != null ? score.toFixed(1) : "—"}
                  </Badge>
                  <a
                    href={`https://www.instagram.com/${username}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline inline-flex items-center gap-1"
                  >
                    @{username}
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </a>
                  {niche && <span className="text-xs text-slate-500">{niche}</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Editable email cards */}
      {sendable.map((preview, idx) => {
        const edit = edits[preview.leadId] ?? { subject: preview.subject, body: preview.body };
        const isDirty = edit.subject !== preview.subject || edit.body !== preview.body;
        const status = cardStatus[preview.leadId] ?? "idle";
        const isSent = status === "sent";
        const isPending = status === "pending";

        return (
          <Card key={preview.leadId} className={isSent ? "opacity-50" : undefined}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-muted-foreground tabular-nums w-5">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={`https://www.instagram.com/${preview.username}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline inline-flex items-center gap-1"
                    >
                      @{preview.username}
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </a>
                    <span className="text-muted-foreground text-sm">{preview.firstName}</span>
                    {preview.emailSource ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-muted-foreground text-sm cursor-default underline decoration-dotted underline-offset-2">→ {preview.email}</span>
                          </TooltipTrigger>
                          <TooltipContent>{preview.emailSource}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-muted-foreground text-sm">→ {preview.email}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge variant="outline" className={`text-xs ${scoreColor(preview.score)}`}>
                      {preview.score != null ? Number(preview.score).toFixed(1) : "—"}
                    </Badge>
                    {preview.status === "review" && <Badge variant="secondary" className="text-xs">review</Badge>}
                    {preview.niche && <span className="text-xs text-muted-foreground">{preview.niche}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!isSent && isDirty && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      title="Reset to original"
                      onClick={() => resetEdit(preview.leadId, { subject: preview.subject, body: preview.body })}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
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
                      onClick={() => handleSendOne(preview)}
                    >
                      {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      {isPending ? "Sending…" : "Send"}
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {cardErrors[preview.leadId] && (
                <p className="text-xs text-destructive">{cardErrors[preview.leadId]}</p>
              )}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs uppercase tracking-wide shrink-0 w-14">Subject</span>
                <Input
                  value={edit.subject}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [preview.leadId]: { ...edit, subject: e.target.value } }))
                  }
                  className="text-sm h-8"
                  disabled={isSent}
                />
              </div>
              <Textarea
                value={edit.body}
                onChange={(e) =>
                  setEdits((prev) => ({ ...prev, [preview.leadId]: { ...edit, body: e.target.value } }))
                }
                className="font-mono text-xs leading-relaxed min-h-[140px] resize-y"
                disabled={isSent}
              />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
