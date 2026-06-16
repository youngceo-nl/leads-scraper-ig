"use client";
import { useState, useTransition } from "react";
import { Send, Loader2, AlertCircle, Check, X, Pencil, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { previewOutreach, sendOutreach } from "@/app/actions/outreach";
import { textToHtml } from "@/lib/outreach/template";

type Props = {
  leadId: string;
  hasEmail: boolean;
  outreachCount: number;
  size?: "sm" | "default";
};

export function SendEmailButton({ leadId, hasEmail, outreachCount, size = "sm" }: Props) {
  const [open, setOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pending, start] = useTransition();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [sent, setSent] = useState(outreachCount > 0);
  // Body editor view: raw text ("edit") vs the rendered HTML the recipient
  // gets ("preview"). Preview uses the SAME textToHtml() the send path applies,
  // so what you see is exactly what is sent.
  const [bodyView, setBodyView] = useState<"edit" | "preview">("edit");

  const openDialog = async () => {
    setError(null);
    setReason(null);
    setBodyView("edit");
    setOpen(true);
    setLoadingPreview(true);
    try {
      const p = await previewOutreach(leadId);
      setTo(p.to ?? "");
      setSubject(p.subject);
      setBody(p.body);
      setReason(p.reason ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingPreview(false);
    }
  };

  const onSend = () => {
    setError(null);
    start(async () => {
      const r = await sendOutreach({ leadId, to, subject, body });
      if (r.ok) {
        setSent(true);
        setOpen(false);
      } else {
        setError(r.error ?? "send failed");
      }
    });
  };

  return (
    <>
      <Button
        variant={sent ? "secondary" : "outline"}
        size={size}
        disabled={!hasEmail && !sent}
        title={!hasEmail ? "Find an email first" : sent ? `Already sent ${outreachCount > 0 ? outreachCount : 1}` : "Send outreach"}
        onClick={openDialog}
      >
        {sent ? <Check className="h-3 w-3 mr-1 text-green-600" /> : <Send className="h-3 w-3 mr-1" />}
        {sent ? `Sent${outreachCount > 1 ? ` ×${outreachCount}` : ""}` : "Send"}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => !pending && setOpen(false)}
        >
          <div
            className="bg-background border rounded-lg shadow-lg w-full max-w-xl p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Send outreach email</h3>
              <button
                onClick={() => !pending && setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {loadingPreview ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading template…
              </div>
            ) : (
              <>
                {reason && (
                  <div className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2">
                    {reason}
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="to" className="text-xs">To</Label>
                  <Input id="to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="subject" className="text-xs">Subject</Label>
                  <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="body" className="text-xs">Body</Label>
                    <div className="inline-flex rounded-md border p-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setBodyView("edit")}
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${bodyView === "edit" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setBodyView("preview")}
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${bodyView === "preview" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        <Eye className="h-3 w-3" /> Preview
                      </button>
                    </div>
                  </div>
                  {bodyView === "edit" ? (
                    <Textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="font-mono text-sm" />
                  ) : (
                    // Renders the exact HTML produced by textToHtml() at send time.
                    // The body is plain text that textToHtml escapes, so the only
                    // markup here is the <p>/<br> it adds — safe to render.
                    <div className="rounded border bg-white">
                      <div className="border-b px-4 py-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{subject || "(no subject)"}</span>
                        <span className="ml-2">to {to || "(no recipient)"}</span>
                      </div>
                      <div
                        className="px-4 py-3 text-sm text-black [&_p]:my-2 [&_a]:text-blue-600 [&_a]:underline min-h-[180px]"
                        dangerouslySetInnerHTML={{ __html: textToHtml(body) }}
                      />
                    </div>
                  )}
                </div>

                {error && (
                  <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
                  <Button onClick={onSend} disabled={pending || !to.trim() || !subject.trim() || !body.trim()}>
                    {pending ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Sending…</> : <><Send className="h-3 w-3 mr-1" /> Send</>}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
