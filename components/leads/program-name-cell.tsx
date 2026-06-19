"use client";
import { useState, useTransition, useRef } from "react";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { saveProgramName } from "@/app/actions/funnel";

export function ProgramNameCell({
  leadId,
  initial,
  platform,
}: {
  leadId: string;
  initial: string | null;
  platform: string | null;
}) {
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const cancel = () => setEditing(false);

  const commit = () => {
    start(async () => {
      const r = await saveProgramName(leadId, draft);
      if (r.ok) {
        setValue(draft.trim() || null);
        setEditing(false);
      }
    });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-[140px]">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
          className="h-6 w-full rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Program name…"
        />
        <button type="button" onClick={commit} disabled={pending} className="text-green-600 hover:text-green-700">
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
        <button type="button" onClick={cancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  if (value) {
    return (
      <div className="group flex items-start gap-1 max-w-[200px]">
        <div className="space-y-0.5 min-w-0">
          <p className="font-medium truncate" title={value}>{value}</p>
          {platform && <span className="text-[10px] text-muted-foreground">{platform}</span>}
        </div>
        <button
          type="button"
          onClick={startEdit}
          className="mt-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground flex-shrink-0"
          title="Edit program name"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
      title="Enter program name"
    >
      <Pencil className="h-3 w-3" />
      <span>Add</span>
    </button>
  );
}
