"use client";
import { useEffect, useState, useCallback, useTransition } from "react";
import { CheckCircle2, Loader2, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getV2ValidationStatus, runV2ValidationBatch, type V2ValidationStatus } from "@/app/actions/enrich";

const PROVIDER_LABELS: Record<string, string> = {
  ig_bio: "IG bio",
  youtube: "YouTube About",
  youtube_free: "YouTube About (public)",
  youtube_capsolver: "YouTube About (gated)",
  ig_mobile: "IG mobile button",
};

export function V2ValidationCard({ initial }: { initial: V2ValidationStatus }) {
  const [data, setData] = useState(initial);
  const [pending, startTransition] = useTransition();

  const poll = useCallback(async () => {
    setData(await getV2ValidationStatus());
  }, []);

  useEffect(() => {
    if (data.queued === 0) return;
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [poll, data.queued]);

  const { cohortSize, queued, ran, found, notFound, hitRate, byProvider, errorSamples } = data;
  const isRunning = queued > 0 && ran > 0 && ran < cohortSize;
  const done = cohortSize > 0 && queued === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>V2 pipeline validation</CardTitle>
          <CardDescription>
            Cohort: qualified, not-yet-contacted leads where V1 already failed to find an email
            ({cohortSize.toLocaleString()} leads).
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={pending || queued === 0}
          onClick={() =>
            startTransition(async () => {
              await runV2ValidationBatch();
              setData(await getV2ValidationStatus());
            })
          }
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlayCircle className="h-3.5 w-3.5" />
          )}
          {queued === 0 ? "All queued" : `Run on ${queued.toLocaleString()} leads`}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-3">
          <Stat label="Ran" value={ran} />
          <Stat label="Found" value={found} className="text-green-700" />
          <Stat label="Not found" value={notFound} className={notFound > 0 ? "text-muted-foreground" : undefined} />
          <Stat label="Hit rate" value={`${hitRate}%`} className={hitRate > 0 ? "text-green-700" : undefined} />
        </div>

        {ran > 0 && (
          <div className="space-y-1">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${done ? "bg-green-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, Math.round((ran / cohortSize) * 100))}%` }}
              />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {done ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
              <span className="tabular-nums">{ran.toLocaleString()} / {cohortSize.toLocaleString()} run</span>
            </div>
          </div>
        )}

        {found > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Hits by source</p>
            <div className="flex gap-2 flex-wrap">
              {Object.entries(byProvider).map(([provider, count]) => (
                <span key={provider} className="text-xs bg-muted rounded-full px-2.5 py-1">
                  {PROVIDER_LABELS[provider] ?? provider}: <strong className="tabular-nums">{count}</strong>
                </span>
              ))}
            </div>
          </div>
        )}

        {errorSamples.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Common miss reasons</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
              {errorSamples.map((e, i) => (
                <li key={i} className="truncate">{e}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, className }: { label: string; value: number | string; className?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</span>
      <span className={`text-xl font-bold tabular-nums ${className ?? ""}`}>{value}</span>
    </div>
  );
}
