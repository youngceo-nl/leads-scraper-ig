"use client";
import { useState, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Mail, Loader2, AlertCircle, Check, RefreshCw, Instagram, Globe, Youtube, X } from "lucide-react";
import type { EnrichProgress, EnrichStage } from "@/lib/pipeline/enrich-progress";
import { saveEmail } from "@/app/actions/funnel";

type Props = {
  leadId: string;
  initialEmail: string | null;
  initialStatus: string | null;
  initialError?: string | null;
  size?: "sm" | "default";
};

type ResultLine = {
  type: "result";
  ok: boolean;
  email?: string | null;
  email_status?: string | null;
  error?: string | null;
  detail?: string | null;
};

export function EnrichButton({ leadId, initialEmail, initialStatus, initialError, size = "sm" }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState(initialStatus);
  // `message` is the human-readable summary; `detail` is the raw step-by-step
  // trace, shown only when the user expands "Details".
  const [message, setMessage] = useState<string | null>(deriveInitialMessage(initialStatus));
  const [detail, setDetail] = useState<string | null>(initialError ?? null);
  const [showDetail, setShowDetail] = useState(false);
  // Live progress of the in-flight run — drives the brand icon + label so the
  // user can see which source we're checking right now.
  const [progress, setProgress] = useState<EnrichProgress | null>(null);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState("");
  const [savePending, startSave] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const onClick = async () => {
    setMessage(null);
    setShowDetail(false);
    setProgress(null);
    setPending(true);
    try {
      const res = await fetch(`/api/enrich/${leadId}`, { method: "POST" });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let final: ResultLine | null = null;

      // Read the NDJSON stream line-by-line; step lines update the live icon,
      // the single result line is applied once the stream ends.
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

  const openManual = () => {
    setDraft("");
    setManual(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitManual = () => {
    const trimmed = draft.trim();
    if (!trimmed || !trimmed.includes("@")) return;
    startSave(async () => {
      const r = await saveEmail(leadId, trimmed);
      if (r.ok) {
        setEmail(trimmed);
        setManual(false);
        router.refresh();
      }
    });
  };

  if (manual) {
    return (
      <div className="flex items-center gap-1 min-w-[180px]">
        <input
          ref={inputRef}
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitManual();
            if (e.key === "Escape") setManual(false);
          }}
          placeholder="email@example.com"
          className="h-7 w-full rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button type="button" onClick={commitManual} disabled={savePending} className="text-green-600 hover:text-green-700 flex-shrink-0">
          {savePending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => setManual(false)} className="text-muted-foreground hover:text-foreground flex-shrink-0">
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

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

  const isError = status === "error";
  // "Tried" = we ran a lookup before (or are showing a prior result), so the
  // primary action becomes "Try again" rather than the first-time "Find email".
  const tried = !!message;

  return (
    <div className="flex flex-col gap-1 max-w-[230px]">
      <div className="group flex items-center gap-1.5">
        <Button
          variant="outline"
          size={size}
          onClick={onClick}
          disabled={pending}
          title={tried ? "Search the public sources again" : "Look up this person's email"}
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
          {pending ? (progress?.label ?? "Looking…") : tried ? "Try again" : "Find email"}
        </Button>

        {tried && !pending && (
          <button
            type="button"
            onClick={openManual}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-muted-foreground hover:text-foreground whitespace-nowrap"
          >
            or enter manually
          </button>
        )}
      </div>

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

// The live source indicator: the brand icon of whatever the pipeline is checking
// right now (Instagram bio → website → YouTube), gently pulsing to read as
// "working". A small spinner overlaps so motion is visible even on the brand
// glyphs. Falls back to a plain spinner before the first step arrives.
function StageIcon({ stage }: { stage: EnrichStage | null }) {
  const base = "h-3 w-3 mr-1";
  if (stage === "bio") return <Instagram className={`${base} text-pink-600 animate-pulse`} />;
  if (stage === "website") return <Globe className={`${base} text-sky-600 animate-pulse`} />;
  if (stage === "youtube") return <Youtube className={`${base} text-red-600 animate-pulse`} />;
  return <Loader2 className={`${base} animate-spin`} />;
}

// On first render we only know the stored status, not a fresh summary, so map
// it to a friendly prompt. A fresh lookup replaces this with the pipeline's
// own message.
function deriveInitialMessage(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === "not_found") return "No public email found. Click to search again.";
  if (status === "error") return "The last search hit a problem. Click to try again.";
  if (status.startsWith("skipped:")) return "Email lookup was skipped for this lead. Click to try now.";
  return null;
}
