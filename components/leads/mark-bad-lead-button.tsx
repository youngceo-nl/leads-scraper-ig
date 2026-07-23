"use client";
import { useState, useTransition } from "react";
import { Flag, Loader2 } from "lucide-react";
import { markBadLead } from "@/app/actions/leads";
import { BAD_LEAD_CATEGORIES, BAD_LEAD_LABELS, type BadLeadCategory } from "@/lib/leads/bad-lead";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

/**
 * Shared "mark this lead bad, with a reason" affordance — used on both the
 * main leads table and the handover batch view (docs/bottlenecks/bottleneck02.md).
 * A small popover rather than an inline confirm: unlike the bad-seeds flow,
 * this one needs to collect a category + optional note before committing.
 */
export function MarkBadLeadButton({ leadId, onMarked }: { leadId: string; onMarked?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [category, setCategory] = useState<BadLeadCategory>("off_icp");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return <span className="text-xs text-muted-foreground" title="Marked bad">flagged</span>;
  }

  const submit = () =>
    start(async () => {
      setError(null);
      const res = await markBadLead(leadId, category, note);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      setDone(true);
      onMarked?.();
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-destructive transition-colors"
          title="Mark as a bad lead"
          aria-label="Mark as a bad lead"
        >
          <Flag className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2">
        <p className="text-xs font-medium">Why is this a bad lead?</p>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as BadLeadCategory)}
          className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
        >
          {BAD_LEAD_CATEGORIES.map((c) => (
            <option key={c} value={c}>{BAD_LEAD_LABELS[c]}</option>
          ))}
        </select>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note…"
          className="min-h-[60px] text-xs"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button size="sm" variant="destructive" className="w-full" disabled={pending} onClick={submit}>
          {pending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Mark bad
        </Button>
      </PopoverContent>
    </Popover>
  );
}
