"use client";
import { useTransition, useState } from "react";
import { Trash2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addEmailProviderKey, removeEmailProviderKey } from "@/app/actions/settings";

const SEP = "|||";

// Stored as "label|||key" or plain "key" for backwards compat.
function parseEntry(raw: string): { label: string | null; key: string } {
  const idx = raw.indexOf(SEP);
  if (idx === -1) return { label: null, key: raw };
  return { label: raw.slice(0, idx) || null, key: raw.slice(idx + SEP.length) };
}

function maskKey(key: string) {
  if (key.length <= 12) return key;
  return key.slice(0, 6) + "…" + key.slice(-4);
}

export function EmailKeyManager({
  provider,
  keys,
  placeholder,
  showLabel = false,
}: {
  provider: "findymail" | "prospeo" | "scrapingbee" | "apify";
  keys: string[];
  placeholder?: string;
  showLabel?: boolean;
}) {
  const [pending, start] = useTransition();
  const [keyInput, setKeyInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

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

  return (
    <div className="space-y-2">
      {keys.length > 0 && (
        <div className="rounded-md border divide-y">
          {keys.map((raw, i) => {
            const { label, key } = parseEntry(raw);
            const isRevealed = revealed.has(i);
            const toggle = () => setRevealed((prev) => {
              const next = new Set(prev);
              next.has(i) ? next.delete(i) : next.add(i);
              return next;
            });
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
                <div className="flex-1 min-w-0">
                  {label && <p className="text-xs font-medium truncate">{label}</p>}
                  <p className="font-mono text-xs text-muted-foreground break-all">
                    {isRevealed ? key : maskKey(key)}
                  </p>
                </div>
                <Button size="icon" variant="ghost" onClick={toggle} aria-label={isRevealed ? "Hide key" : "Reveal key"}>
                  {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => start(() => removeEmailProviderKey(provider, i))}
                  aria-label="Remove key"
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
