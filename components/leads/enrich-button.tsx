"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Mail, Loader2, AlertCircle, Check } from "lucide-react";
import { enrichLead } from "@/app/actions/enrich";

type Props = {
  leadId: string;
  initialEmail: string | null;
  initialStatus: string | null;
  initialError?: string | null;
  size?: "sm" | "default";
};

export function EnrichButton({ leadId, initialEmail, initialStatus, initialError, size = "sm" }: Props) {
  const [pending, start] = useTransition();
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const onClick = () => {
    setError(null);
    start(async () => {
      const r = await enrichLead(leadId);
      if (r.ok) {
        setEmail(r.email ?? null);
        setStatus(r.email_status ?? null);
        setError(null);
      } else {
        setError(r.error ?? "unknown error");
        setStatus(r.email_status ?? null);
      }
    });
  };

  if (email) {
    return (
      <a
        href={`mailto:${email}`}
        className="inline-flex items-center gap-1 text-xs hover:underline"
        title={status ?? "found"}
      >
        <Check className="h-3 w-3 text-green-600" />
        <span className="truncate max-w-[180px]">{email}</span>
      </a>
    );
  }

  const skipped = status?.startsWith("skipped:");
  const errored = status === "error";

  // Show the first meaningful step from the trace (bio/website/yt_...) as a short label
  const shortTrace = error
    ? error.split(" · ").slice(0, 3).join(" · ")
    : null;

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size={size}
        onClick={onClick}
        disabled={pending}
        title={error ?? (skipped ? `Last attempt: ${status}` : errored ? "Last attempt failed" : "Look up this person's email")}
      >
        {pending ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : errored || error ? (
          <AlertCircle className="h-3 w-3 mr-1 text-red-600" />
        ) : (
          <Mail className="h-3 w-3 mr-1" />
        )}
        {pending ? "Looking…" : errored || error ? "Try again" : "Find email"}
      </Button>
      {shortTrace && (
        <span
          className="text-[10px] text-muted-foreground max-w-[200px] truncate cursor-help"
          title={error ?? ""}
        >
          {shortTrace}
        </span>
      )}
    </div>
  );
}
