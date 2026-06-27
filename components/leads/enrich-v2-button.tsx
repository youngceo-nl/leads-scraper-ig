"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Mail, Loader2, AlertCircle, Check, RefreshCw, Instagram, Youtube } from "lucide-react";
import type { EnrichProgress, EnrichStage } from "@/lib/pipeline/enrich-progress";

type Props = {
  leadId: string;
  initialEmail: string | null;
  initialStatus: string | null;
  initialError?: string | null;
};

type ResultLine = {
  type: "result";
  ok: boolean;
  email?: string | null;
  email_status?: string | null;
  error?: string | null;
  detail?: string | null;
};

export function EnrichV2Button({ leadId, initialEmail, initialStatus, initialError }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState(initialStatus);
  const [message, setMessage] = useState<string | null>(deriveInitialMessage(initialStatus));
  const [detail, setDetail] = useState<string | null>(initialError ?? null);
  const [showDetail, setShowDetail] = useState(false);
  const [progress, setProgress] = useState<EnrichProgress | null>(null);

  const onClick = async () => {
    setMessage(null);
    setShowDetail(false);
    setProgress(null);
    setPending(true);
    try {
      const res = await fetch(`/api/enrich-v2/${leadId}`, { method: "POST" });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let final: ResultLine | null = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { type: string } & Record<string, unknown>;
          if (ev.type === "step") setProgress(ev as unknown as EnrichProgress);
          else if (ev.type === "result") final = ev as unknown as ResultLine;
        }
      }

      if (final) {
        setStatus((final.email_status as string) ?? null);
        if (final.ok && final.email) {
          setEmail(final.email);
          setMessage(null);
          setDetail(null);
          router.refresh();
        } else {
          setMessage(final.error ?? "Something went wrong. Please try again.");
          setDetail(final.detail ?? null);
        }
      }
    } catch {
      setMessage("Something went wrong. Please try again.");
    } finally {
      setPending(false);
      setProgress(null);
    }
  };

  if (email) {
    return (
      <a
        href={`mailto:${email}`}
        className="inline-flex items-center gap-1 text-xs hover:underline"
        title={status ?? "found"}
      >
        <Check className="h-3 w-3 text-green-600" />
        <span className="truncate max-w-[200px]">{email}</span>
      </a>
    );
  }

  const isError = status === "error";
  const tried = !!message;

  return (
    <div className="flex flex-col gap-1 max-w-[240px]">
      <Button
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={pending}
        title={tried ? "Run v2 enrichment again" : "Run v2 enrichment (bio → YouTube → IG mobile)"}
      >
        {pending ? (
          <StageIcon stage={progress?.stage ?? null} />
        ) : isError ? (
          <AlertCircle className="h-3 w-3 mr-1 text-red-600" />
        ) : tried ? (
          <RefreshCw className="h-3 w-3 mr-1 text-amber-600" />
        ) : (
          <Mail className="h-3 w-3 mr-1" />
        )}
        {pending ? (progress?.label ?? "Looking…") : tried ? "Try again" : "Enrich V2"}
      </Button>

      {!pending && message && (
        <div className={`text-[11px] leading-snug ${isError ? "text-red-600" : "text-muted-foreground"}`}>
          <p>{message}</p>
          {detail && (
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className="mt-0.5 underline decoration-dotted hover:text-foreground"
            >
              {showDetail ? "Hide details" : "Details"}
            </button>
          )}
          {showDetail && detail && (
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground/80">
              {detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StageIcon({ stage }: { stage: EnrichStage | null }) {
  const base = "h-3 w-3 mr-1";
  if (stage === "bio") return <Instagram className={`${base} text-pink-600 animate-pulse`} />;
  if (stage === "youtube") return <Youtube className={`${base} text-red-600 animate-pulse`} />;
  if (stage === "ig_mobile") return <Instagram className={`${base} text-purple-600 animate-pulse`} />;
  return <Loader2 className={`${base} animate-spin`} />;
}

function deriveInitialMessage(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === "not_found") return "No email found. Click to run again.";
  if (status === "error") return "Last run hit a problem. Click to try again.";
  return null;
}
