"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw, Mail, MailOpen, AlertCircle, ChevronDown, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { syncInbox, markReplyRead } from "@/app/actions/inbox";

export type InboxReply = {
  id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string;
  is_read: boolean;
  lead_username: string | null;
  lead_full_name: string | null;
};

export function InboxClient({ initial }: { initial: InboxReply[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = () => {
    setStatus(null);
    start(async () => {
      const r = await syncInbox();
      if (r.ok) {
        setStatus({ ok: true, msg: `Synced — ${r.new_replies ?? 0} new repl${r.new_replies === 1 ? "y" : "ies"} (scanned ${r.scanned ?? 0}).` });
        router.refresh();
      } else {
        setStatus({ ok: false, msg: r.error ?? "Sync failed." });
      }
    });
  };

  const toggle = (reply: InboxReply) => {
    const next = open === reply.id ? null : reply.id;
    setOpen(next);
    if (next && !reply.is_read) {
      void markReplyRead(reply.id, true).then(() => router.refresh());
    }
  };

  const unread = initial.filter((r) => !r.is_read).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button onClick={refresh} disabled={pending} variant="outline" size="sm">
          <RefreshCw className={`h-4 w-4 mr-2 ${pending ? "animate-spin" : ""}`} />
          {pending ? "Checking for replies…" : "Refresh"}
        </Button>
        {unread > 0 && <Badge variant="secondary">{unread} unread</Badge>}
        {status && (
          <span className={`text-xs flex items-center gap-1 ${status.ok ? "text-green-700" : "text-red-700"}`}>
            {!status.ok && <AlertCircle className="h-3.5 w-3.5" />}
            {status.msg}
          </span>
        )}
      </div>

      {initial.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No replies yet. Hit <b>Refresh</b> to check your mailbox for responses to your outreach.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {initial.map((r) => {
            const isOpen = open === r.id;
            return (
              <li key={r.id} className={r.is_read ? "" : "bg-accent/30"}>
                <button
                  type="button"
                  onClick={() => toggle(r)}
                  className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-accent/40 transition-colors"
                >
                  {r.is_read ? (
                    <MailOpen className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Mail className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate ${r.is_read ? "" : "font-semibold"}`}>
                        {r.from_name || r.from_email || "Unknown sender"}
                      </span>
                      {r.lead_username && (
                        <Badge variant="outline" className="shrink-0">@{r.lead_username}</Badge>
                      )}
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {new Date(r.received_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="truncate text-sm">{r.subject || "(no subject)"}</div>
                    {!isOpen && r.snippet && (
                      <div className="truncate text-xs text-muted-foreground mt-0.5">{r.snippet}</div>
                    )}
                  </div>
                  <ChevronDown className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 pl-11 space-y-3">
                    <div className="rounded-md border bg-background p-3 text-sm whitespace-pre-wrap break-words">
                      {r.body_text?.trim() || r.snippet || "(empty message)"}
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      {r.from_email && (
                        <a href={`mailto:${r.from_email}`} className="inline-flex items-center gap-1 hover:underline">
                          <Mail className="h-3 w-3" /> Reply in email
                        </a>
                      )}
                      {r.lead_username && (
                        <Link href={`/leads/${r.lead_username}`} className="inline-flex items-center gap-1 hover:underline">
                          <ExternalLink className="h-3 w-3" /> View lead
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
