"use client";
import { useTransition, useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addBurnerCookie, removeBurnerCookie } from "@/app/actions/settings";
import { TestCookieButton } from "@/components/settings/test-cookie-button";

function maskCookie(cookie: string) {
  if (cookie.length <= 24) return cookie;
  return cookie.slice(0, 20) + "…" + cookie.slice(-4);
}

export function BurnerCookieManager({ cookies }: { cookies: string[] }) {
  const [pending, start] = useTransition();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setError(null);
    start(async () => {
      const res = await addBurnerCookie(input);
      if (res && "error" in res) { setError(res.error); return; }
      setInput("");
    });
  };

  return (
    <div className="space-y-3">
      {cookies.length > 0 && (
        <div className="rounded-md border divide-y">
          {cookies.map((c, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1 font-mono text-xs text-muted-foreground truncate" title={c}>
                {maskCookie(c)}
              </span>
              <Button
                size="icon"
                variant="ghost"
                disabled={pending}
                onClick={() => start(() => removeBurnerCookie(i))}
                aria-label="Remove cookie"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="sessionid=...; ds_user_id=...; csrftoken=...; ig_did=...; mid=..."
        rows={2}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
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
        <TestCookieButton />
      </div>
      <p className="text-xs text-muted-foreground">
        Add one cookie per burner account. When one gets rate-limited, the scraper automatically switches to the next.
      </p>
    </div>
  );
}
