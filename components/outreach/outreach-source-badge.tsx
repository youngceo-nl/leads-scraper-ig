"use client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { HandoverOutcome } from "@/lib/handover/outcomes";

export function OutreachSourceBadge({
  username,
  outcome,
}: {
  username: string;
  outcome: HandoverOutcome | null;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="text-xs text-muted-foreground hover:text-foreground hover:underline cursor-pointer">
          @{username}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto">
        <p className="font-medium">@{username}</p>
        {outcome ? (
          <p className="text-muted-foreground text-xs mt-0.5">
            {outcome.accepted} accepted · {outcome.noEmail} no email · {outcome.markedBad} marked bad
          </p>
        ) : (
          <p className="text-muted-foreground text-xs mt-0.5">No handover data yet</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
