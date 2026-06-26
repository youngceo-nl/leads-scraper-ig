"use client";
import { useTransition, useState } from "react";
import { Trash2, Eye, EyeOff, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addEmailProviderKey, removeEmailProviderKey, checkEmailProviderKey } from "@/app/actions/settings";
import type { EmailKeyStatus } from "@/lib/types";

const SEP = "|||";

function parseEntry(raw: string): { label: string | null; key: string } {
  const idx = raw.indexOf(SEP);
  if (idx === -1) return { label: null, key: raw };
  return { label: raw.slice(0, idx) || null, key: raw.slice(idx + SEP.length) };
}

function maskKey(key: string) {
  if (key.length <= 12) return key;
  return key.slice(0, 6) + "…" + key.slice(-4);
}

function statusId(provider: string, key: string) {
  return `${provider}:${key.slice(-12)}`;
}

function StatusBadge({ status, checking }: { status: EmailKeyStatus | undefined; checking: boolean }) {
  if (checking) return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <RefreshCw className="h-3 w-3 animate-spin" /> Checking…
    </span>
  );
  if (!status) return <span className="text-[11px] text-muted-foreground/50">not tested</span>;

  const map: Record<EmailKeyStatus["status"], { dot: string; label: string }> = {
    ok:           { dot: "bg-green-500",  label: status.credits != null ? `${status.credits} credits` : "ok" },
    exhausted:    { dot: "bg-red-500",    label: "quota exhausted" },
    invalid:      { dot: "bg-red-500",    label: "invalid key" },
    rate_limited: { dot: "bg-amber-400",  label: "rate limited" },
  };
  const { dot, label } = map[status.status];
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} />
      <span className={status.status === "ok" ? "text-green-600" : status.status === "rate_limited" ? "text-amber-600" : "text-destructive"}>
        {label}
      </span>
    </span>
  );
}

export function EmailKeyManager({
  provider,
  keys,
  placeholder,
  showLabel = false,
  keyStatuses: initialStatuses = {},
}: {
  provider: "findymail" | "prospeo" | "scrapingbee" | "apify";
  keys: string[];
  placeholder?: string;
  showLabel?: boolean;
  keyStatuses?: Record<string, EmailKeyStatus>;
}) {
  const [pending, start] = useTransition();
  const [keyInput, setKeyInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, EmailKeyStatus>>(initialStatuses);
  const [checking, setChecking] = useState<Set<string>>(new Set());

  const handleAdd = () => {
    setError(null);
    const stored = showLabel && labelInput.trim()
      ? `${labelInput.trim()}${SEP}${keyInput.trim()}`
      : keyInput.trim();
    start(async () => {
      const res = await addEmailProviderKey(provider, stored);
      if (res && "error" in res) { setError(res.error ?? "Failed to add key"); return; }
      setKeyInput("");
      setLabelInput("");
    });
  };

  const handleTest = async (rawKey: string) => {
    const { key } = parseEntry(rawKey);
    const id = statusId(provider, key);
    setChecking((prev) => new Set(prev).add(id));
    try {
      const result = await checkEmailProviderKey(provider, rawKey);
      setStatuses((prev) => ({ ...prev, [id]: result }));
    } finally {
      setChecking((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  const allExhausted = keys.length > 0 && keys.every((raw) => {
    const { key } = parseEntry(raw);
    const s = statuses[statusId(provider, key)];
    return s?.status === "exhausted" || s?.status === "invalid";
  });

  const anyTested = keys.some((raw) => {
    const { key } = parseEntry(raw);
    return !!statuses[statusId(provider, key)];
  });

  return (
    <div className="space-y-2">
      {allExhausted && anyTested && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          All {provider} keys are exhausted or invalid — email enrichment via this provider is paused.
        </div>
      )}
      {keys.length > 0 && (
        <div className="rounded-md border divide-y">
          {keys.map((raw, i) => {
            const { label, key } = parseEntry(raw);
            const id = statusId(provider, key);
            const isRevealed = revealed.has(i);
            const isChecking = checking.has(id);
            const toggle = () => setRevealed((prev) => {
              const next = new Set(prev);
              next.has(i) ? next.delete(i) : next.add(i);
              return next;
            });
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
                <div className="flex-1 min-w-0 space-y-0.5">
                  {label && <p className="text-xs font-medium truncate">{label}</p>}
                  <p className="font-mono text-xs text-muted-foreground break-all">
                    {isRevealed ? key : maskKey(key)}
                  </p>
                  <StatusBadge status={statuses[id]} checking={isChecking} />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs shrink-0"
                  disabled={isChecking}
                  onClick={() => void handleTest(raw)}
                  title="Test this key"
                >
                  Test
                </Button>
                <Button size="icon" variant="ghost" onClick={toggle} aria-label={isRevealed ? "Hide key" : "Reveal key"} className="shrink-0">
                  {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => start(() => removeEmailProviderKey(provider, i))}
                  aria-label="Remove key"
                  className="shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {showLabel && (
          <Input
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder="Account email (e.g. user@gmail.com)"
            className="text-sm"
          />
        )}
        <div className="flex gap-2">
          <Input
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={placeholder ?? "API key"}
            className="font-mono text-sm"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
          />
          <Button type="button" variant="outline" disabled={pending || !keyInput.trim()} onClick={handleAdd}>
            Add
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {keys.length > 1 && (
        <p className="text-xs text-muted-foreground">{keys.length} keys — rotated round-robin, skipped when quota is exhausted.</p>
      )}
    </div>
  );
}
