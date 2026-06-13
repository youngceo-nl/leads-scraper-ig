"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RotateCw, Check } from "lucide-react";
import { backfillMissingBios, getBioCoverage, type BioCoverage } from "@/app/actions/backfill-bios";

export function BioCoverageCard({ initial }: { initial: BioCoverage }) {
  const [cov, setCov] = useState<BioCoverage>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const watchUntil = useRef<number>(0);

  const pct = cov.total > 0 ? Math.round((cov.withBio / cov.total) * 100) : 100;

  // After queueing a backfill, poll coverage so the user watches bios land in
  // the database. Stop once everything's covered or after a few minutes.
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const id = setInterval(async () => {
      const next = await getBioCoverage();
      if (cancelled) return;
      setCov(next);
      if (next.missing === 0 || Date.now() > watchUntil.current) setWatching(false);
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [watching]);

  const onClick = () => {
    setMsg(null);
    start(async () => {
      const res = await backfillMissingBios();
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      if (res.queued === 0) {
        setMsg("Every lead already has a bio stored. ✅");
        return;
      }
      setMsg(
        `Fetching ${res.queued.toLocaleString()} bio${res.queued === 1 ? "" : "s"} with your burner account` +
          (res.capped ? " (first 1,000 — run again for the rest)" : "") +
          ". They'll fill in over the next few minutes.",
      );
      watchUntil.current = Date.now() + 5 * 60 * 1000;
      setWatching(true);
    });
  };

  const allCovered = cov.missing === 0 && cov.total > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {cov.total === 0 ? (
            "No leads yet."
          ) : (
            <>
              <b className="text-foreground tabular-nums">{cov.withBio.toLocaleString()}</b> of{" "}
              <span className="tabular-nums">{cov.total.toLocaleString()}</span> leads have a bio stored
            </>
          )}
        </span>
        <span className="tabular-nums text-muted-foreground">{pct}%</span>
      </div>

      {cov.total > 0 && <Progress value={pct} state={allCovered ? "done" : "running"} size="sm" />}

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={onClick}
          disabled={pending || allCovered}
          title="Look up bios for any leads that don't have one yet, using your Instagram burner account"
        >
          {allCovered ? (
            <Check className="h-3.5 w-3.5 mr-1 text-green-600" />
          ) : (
            <RotateCw className={`h-3.5 w-3.5 mr-1 ${pending || watching ? "animate-spin" : ""}`} />
          )}
          {allCovered
            ? "All bios stored"
            : pending
              ? "Queueing…"
              : `Fetch ${cov.missing.toLocaleString()} missing bio${cov.missing === 1 ? "" : "s"}`}
        </Button>
        {watching && <span className="text-xs text-muted-foreground">Updating as bios are saved…</span>}
      </div>

      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
