"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Eye, Loader2, Pencil, RotateCcw, Send, TriangleAlert } from "lucide-react";
import { saveOutreachFields, sendOutreachEmail } from "@/app/actions/outreach-ready";
import { textToHtml } from "@/lib/outreach/template";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Draft, OutreachRow } from "./outreach-ready-client";

export function OutreachComposer({
  row,
  draft,
  onDraftChange,
  subject,
  body,
  firstName,
  programName,
  senderName,
  alreadySent,
  dryRun,
  onSent,
}: {
  row: OutreachRow;
  draft: Draft;
  onDraftChange: (patch: Partial<Draft>) => void;
  subject: string;
  body: string;
  firstName: string;
  programName: string;
  senderName: string | null;
  alreadySent: boolean;
  dryRun: boolean;
  onSent: () => void;
}) {
  const router = useRouter();
  const [to, setTo] = useState(row.email);
  const [saving, startSave] = useTransition();
  const [sending, startSend] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the user hand-edits the body it wins over the live re-render, so a
  // later name fix can't silently discard their wording.
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const effectiveBody = bodyOverride ?? body;
  const dirty =
    draft.full_name !== (row.full_name ?? "") ||
    draft.funnel_program_name !== (row.funnel_program_name ?? "");

  const genericGreeting = firstName === "there";
  const fallbackProgram = !draft.funnel_program_name.trim();

  const save = () => {
    setError(null);
    setSaved(false);
    startSave(async () => {
      const r = await saveOutreachFields(row.id, {
        full_name: draft.full_name,
        funnel_program_name: draft.funnel_program_name,
      });
      if (r.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(r.error ?? "Save failed");
      }
    });
  };

  const send = () => {
    const warn = [
      `Send this email to ${to}?`,
      genericGreeting ? "\n⚠ The greeting will say “Hey there” — no first name resolved." : "",
      fallbackProgram ? "\n⚠ The subject uses a generic fallback program name." : "",
    ]
      .filter(Boolean)
      .join("");
    if (!window.confirm(warn)) return;

    setError(null);
    startSend(async () => {
      const r = await sendOutreachEmail({ leadId: row.id, to, subject, body: effectiveBody });
      if (r.ok) onSent();
      else setError(r.error ?? "Send failed");
    });
  };

  return (
    <div className="overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-5">
        {dryRun && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>
              <strong>Dry run</strong> — sends are simulated. No email leaves the app and nothing is written.
            </span>
          </div>
        )}

        <div>
          <h2 className="text-lg font-semibold tracking-tight">@{row.username}</h2>
          <p className="text-xs text-muted-foreground">
            {row.niche ?? "unknown niche"}
            {row.overall_score != null && ` · score ${row.overall_score}`}
            {row.email_provider && ` · email via ${row.email_provider}`}
          </p>
        </div>

        {/* The two fields automation gets wrong. Raw DB values shown beneath so
            the user can see exactly what they're replacing. */}
        <div className="grid grid-cols-2 gap-4 rounded-lg border p-4">
          <div className="space-y-1.5">
            <Label htmlFor="full_name">Full name</Label>
            <Input
              id="full_name"
              value={draft.full_name}
              onChange={(e) => onDraftChange({ full_name: e.target.value })}
              placeholder="—"
            />
            <p className="text-xs text-muted-foreground truncate">
              Scraped: {row.full_name ? `“${row.full_name}”` : "none"}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="program_name">Program name</Label>
            <Input
              id="program_name"
              value={draft.funnel_program_name}
              onChange={(e) => onDraftChange({ funnel_program_name: e.target.value })}
              placeholder="—"
            />
            <p className="text-xs text-muted-foreground truncate">
              Scraped: {row.funnel_program_name ? `“${row.funnel_program_name}”` : "none"}
            </p>
          </div>

          <div className="col-span-2 flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving || !dirty}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Save
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onDraftChange({
                    full_name: row.full_name ?? "",
                    funnel_program_name: row.funnel_program_name ?? "",
                  })
                }
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Revert
              </Button>
            )}
            {saved && !dirty && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="to">To</Label>
          <Input id="to" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>

        {/* Preview */}
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted/40 px-4 py-3 border-b space-y-1 text-sm">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-16 shrink-0">From</span>
              <span>{senderName ?? "(no sender name set)"}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-16 shrink-0">To</span>
              <span className="truncate">{to}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-16 shrink-0">Subject</span>
              <span className="font-medium">{subject}</span>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
            <span className="text-xs text-muted-foreground">
              {bodyOverride !== null ? "Hand-edited body" : "Rendered from template"}
            </span>
            <div className="flex items-center gap-1">
              {bodyOverride !== null && (
                <Button size="sm" variant="ghost" onClick={() => setBodyOverride(null)}>
                  Revert to template
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
                {editing ? <Eye className="h-3.5 w-3.5 mr-1.5" /> : <Pencil className="h-3.5 w-3.5 mr-1.5" />}
                {editing ? "Preview" : "Edit"}
              </Button>
            </div>
          </div>

          {editing ? (
            <Textarea
              value={effectiveBody}
              onChange={(e) => setBodyOverride(e.target.value)}
              className="min-h-[320px] rounded-none border-0 font-mono text-xs focus-visible:ring-0"
            />
          ) : (
            <div
              className="p-5 bg-white text-black text-sm [&_p]:my-2 [&_a]:text-blue-600 [&_a]:underline"
              dangerouslySetInnerHTML={{ __html: textToHtml(effectiveBody) }}
            />
          )}
        </div>

        {(genericGreeting || fallbackProgram) && (
          <div className="text-xs text-amber-700 space-y-1">
            {genericGreeting && <p>⚠ No first name resolved — the greeting reads “Hey there”.</p>}
            {fallbackProgram && <p>⚠ No program name — the subject falls back to “{programName}”.</p>}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3 pb-6">
          <Button onClick={send} disabled={sending || alreadySent}>
            {sending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            {alreadySent ? "Sent" : dryRun ? "Send (dry run)" : `Send to ${to}`}
          </Button>
          {dirty && (
            <span className="text-xs text-muted-foreground">
              Unsaved edits are still used in the email you send.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
