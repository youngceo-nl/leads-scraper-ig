"use client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function SourceBadge({
  username,
  count,
}: {
  username: string;
  count: number;
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
        <p className="text-muted-foreground text-xs mt-0.5">{count} lead{count !== 1 ? "s" : ""} scraped</p>
      </PopoverContent>
    </Popover>
  );
}
