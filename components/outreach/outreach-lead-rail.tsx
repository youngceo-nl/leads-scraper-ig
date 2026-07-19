"use client";
import { CheckCircle2 } from "lucide-react";
import { cn, scoreColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { Draft, OutreachRow } from "./outreach-ready-client";

export function OutreachLeadRail({
  rows,
  selectedId,
  onSelect,
  sentIds,
  drafts,
  readyCount,
  needsFixCount,
  sentToday,
  needsFixOnly,
  onToggleNeedsFix,
}: {
  rows: OutreachRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  sentIds: Set<string>;
  drafts: Record<string, Draft>;
  readyCount: number;
  needsFixCount: number;
  sentToday: number;
  needsFixOnly: boolean;
  onToggleNeedsFix: () => void;
}) {
  // Unsaved edits shouldn't leave a row flagged as broken.
  const stillNeedsFix = (row: OutreachRow) => {
    const d = drafts[row.id];
    if (!d) return row.needsFix;
    return !d.funnel_program_name.trim() || !d.full_name.trim();
  };

  const visible = needsFixOnly ? rows.filter((r) => stillNeedsFix(r) && !sentIds.has(r.id)) : rows;

  return (
    <aside className="border-r bg-muted/20 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b space-y-2">
        <h1 className="font-semibold tracking-tight">Outreach Ready</h1>
        <p className="text-xs text-muted-foreground">
          {readyCount} ready · {needsFixCount} need fix · {sentToday} sent today
        </p>
        <button
          type="button"
          onClick={onToggleNeedsFix}
          className={cn(
            "text-xs px-2 py-1 rounded-md border transition-colors",
            needsFixOnly ? "bg-amber-100 border-amber-300 text-amber-900" : "hover:bg-accent",
          )}
        >
          Needs fix only
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {visible.map((row) => {
          const sent = sentIds.has(row.id);
          const broken = stillNeedsFix(row);
          const d = drafts[row.id];
          const name = (d?.full_name ?? row.full_name ?? "").trim();
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row.id)}
              className={cn(
                "w-full text-left px-4 py-2.5 border-b hover:bg-accent transition-colors",
                row.id === selectedId && "bg-accent",
                sent && "opacity-50",
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("text-xs font-semibold tabular-nums", scoreColor(row.overall_score))}>
                  {row.overall_score ?? "–"}
                </span>
                <span className={cn("text-sm truncate", sent && "line-through")}>@{row.username}</span>
                {sent && <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0 ml-auto" />}
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {name || row.username}
              </div>
              {!sent && broken && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {!(d?.funnel_program_name ?? row.funnel_program_name) && (
                    <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">
                      No program name
                    </Badge>
                  )}
                  {!(d?.full_name ?? row.full_name) && (
                    <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">
                      No name
                    </Badge>
                  )}
                  {row.status === "review" && (
                    <Badge variant="secondary" className="text-[10px]">review</Badge>
                  )}
                </div>
              )}
            </button>
          );
        })}
        {visible.length === 0 && (
          <p className="text-xs text-muted-foreground px-4 py-6 text-center">
            Nothing left needing a fix.
          </p>
        )}
      </div>
    </aside>
  );
}
