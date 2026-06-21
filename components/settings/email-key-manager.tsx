"use client";
import { useTransition, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addEmailProviderKey, removeEmailProviderKey } from "@/app/actions/settings";

function maskKey(key: string) {
  if (key.length <= 12) return key;
  return key.slice(0, 6) + "…" + key.slice(-4);
}

export function EmailKeyManager({
  provider,
  keys,
  placeholder,
}: {
  provider: "findymail" | "prospeo";
  keys: string[];
  placeholder?: string;
}) {
  const [pending, start] = useTransition();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setError(null);
    start(async () => {
      const res = await addEmailProviderKey(provider, input);
      if (res && "error" in res) { setError(res.error ?? "Failed to add key"); return; }
      setInput("");
    });
  };

  return (
    <div className="space-y-2">
      {keys.length > 0 && (
        <div className="rounded-md border divide-y">
          {keys.map((k, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1 font-mono text-xs text-muted-foreground">{maskKey(k)}</span>
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
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder ?? "API key"}
          className="font-mono text-sm"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
        />
        <Button type="button" variant="outline" disabled={pending || !input.trim()} onClick={handleAdd}>
          Add
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {keys.length > 1 && (
        <p className="text-xs text-muted-foreground">{keys.length} keys — rotated round-robin, skipped when quota is exhausted.</p>
      )}
    </div>
  );
}
