"use client";
import { useTransition, useState } from "react";
import { Trash2, Plus, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addYtCookie, removeYtCookie } from "@/app/actions/settings";
import type { CookieLiveness } from "@/lib/youtube/refresh-cookie";

function maskCookie(cookie: string) {
  if (cookie.length <= 24) return cookie;
  return cookie.slice(0, 20) + "…" + cookie.slice(-4);
}

// Cookie-Editor exports JSON: [{name, value, ...}, ...] → "name=value; name=value"
function normalizeCookieInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { name: string; value: string }[];
    if (!Array.isArray(parsed)) return trimmed;
    return parsed.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return trimmed;
  }
}

function LivenessIcon({ status }: { status: CookieLiveness }) {
  if (status === "live") return <CheckCircle2 aria-label="Cookie is active" className="h-3.5 w-3.5 shrink-0 text-green-500" />;
  if (status === "dead") return <XCircle aria-label="Cookie is expired" className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return <MinusCircle aria-label="Status unknown" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

export function YtCookieManager({ cookies, liveness = [] }: { cookies: string[]; liveness?: CookieLiveness[] }) {
  const [pending, start] = useTransition();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setError(null);
    start(async () => {
      const res = await addYtCookie(normalizeCookieInput(input));
      if (res && "error" in res) { setError(res.error ?? "Failed to add cookie"); return; }
      setInput("");
    });
  };

  return (
    <div className="space-y-3">
      {cookies.length > 0 && (
        <div className="rounded-md border divide-y">
          {cookies.map((c, i) => {
            const status = liveness[i] ?? "unknown";
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
                <LivenessIcon status={status} />
                <span className="flex-1 font-mono text-xs text-muted-foreground truncate" title={c}>
                  {maskCookie(c)}
                </span>
                {status === "dead" && (
                  <span className="text-xs text-destructive font-medium shrink-0">Expired</span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => start(() => removeYtCookie(i))}
                  aria-label="Remove cookie"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste Cookie-Editor JSON export or the raw Cookie: header string"
        rows={2}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={pending || !input.trim()}
        onClick={handleAdd}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        {pending ? "Adding…" : "Add cookie"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Use the Cookie-Editor browser extension on YouTube → Export → Export as JSON, then paste here. One cookie per Google account — when one expires the scraper uses the next.
      </p>
    </div>
  );
}
