"use client";
import { useEffect, useState } from "react";
import { Columns3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  LEAD_COLUMNS,
  LEAD_COLUMN_STORAGE_KEY,
  DEFAULT_VISIBLE_COLUMNS,
} from "@/lib/leads/columns";

type Visibility = Record<string, boolean>;

export function ColumnVisibility() {
  // Start from defaults so the server render and the first client render agree
  // (no hydration mismatch); pull the saved preference in once mounted.
  const [visible, setVisible] = useState<Visibility>(DEFAULT_VISIBLE_COLUMNS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LEAD_COLUMN_STORAGE_KEY);
      if (raw) setVisible({ ...DEFAULT_VISIBLE_COLUMNS, ...JSON.parse(raw) });
    } catch {
      /* ignore malformed prefs */
    }
  }, []);

  const persist = (next: Visibility) => {
    setVisible(next);
    try {
      localStorage.setItem(LEAD_COLUMN_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const toggle = (key: string) => persist({ ...visible, [key]: !visible[key] });
  const reset = () => persist({ ...DEFAULT_VISIBLE_COLUMNS });

  const hideable = LEAD_COLUMNS.filter((c) => c.hideable);
  const hiddenCount = hideable.filter((c) => !visible[c.key]).length;

  // Hide turned-off columns via CSS so the table stays a server component.
  const css = LEAD_COLUMNS.filter((c) => c.hideable && !visible[c.key])
    .map((c) => `.leads-table [data-col="${c.key}"]{display:none}`)
    .join("");

  return (
    <>
      <style>{css}</style>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="secondary">
            <Columns3 className="h-4 w-4 mr-2" />
            Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-xs font-medium text-muted-foreground">Show columns</span>
            <button
              type="button"
              onClick={reset}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              title="Reset to default columns"
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          </div>
          <div className="max-h-72 overflow-auto">
            {hideable.map((c) => (
              <label
                key={c.key}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-sm cursor-pointer hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={!!visible[c.key]}
                  onChange={() => toggle(c.key)}
                  className="h-4 w-4 rounded border-input"
                />
                {c.label}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
