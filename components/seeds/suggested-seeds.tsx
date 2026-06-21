"use client";
import { useState, useTransition } from "react";
import { Plus, Check, ExternalLink, ChevronsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addSeed, addSeedsBulk } from "@/app/actions/seeds";

type SuggestedSeed = {
  username: string;
  profile_url: string;
  followers: number | null;
  following: number | null;
  overall_score: number | null;
  niche: string | null;
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function SuggestedSeeds({ candidates }: { candidates: SuggestedSeed[] }) {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  const handleAddAll = () => {
    start(async () => {
      const remaining = candidates.filter((c) => !added.has(c.username)).map((c) => c.username);
      const res = await addSeedsBulk(remaining);
      setAdded((prev) => new Set([...prev, ...remaining]));
      setBulkMsg(`Added ${res.added} seeds${res.skipped ? `, skipped ${res.skipped}` : ""}.`);
    });
  };

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No qualified leads yet. Run a crawl first — once leads are scored, the best ones show up here as seed candidates.
      </p>
    );
  }

  const handleAdd = (username: string) => {
    start(async () => {
      const fd = new FormData();
      fd.set("input", username);
      const res = await addSeed(fd);
      if (!("error" in res) || !res.error) setAdded((prev) => new Set([...prev, username]));
    });
  };

  const allAdded = candidates.every((c) => added.has(c.username));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{candidates.length} accounts</p>
        <div className="flex items-center gap-2">
          {bulkMsg && <span className="text-xs text-muted-foreground">{bulkMsg}</span>}
          <Button size="sm" variant="secondary" disabled={pending || allAdded} onClick={handleAddAll}>
            <ChevronsUp className="h-3.5 w-3.5 mr-1.5" />
            {allAdded ? "All added" : `Add all ${candidates.length}`}
          </Button>
        </div>
      </div>
    <div className="rounded-md border divide-y">
      {candidates.map((c) => {
        const isAdded = added.has(c.username);
        return (
          <div key={c.username} className="flex items-center gap-3 p-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-sm">@{c.username}</span>
                <a href={c.profile_url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                {c.niche && <span>{c.niche}</span>}
                <span>·</span>
                {c.following != null
                  ? <span className="font-medium text-foreground">{fmt(c.following)} following</span>
                  : <span>? following</span>}
                {c.followers != null && <><span>·</span><span>{fmt(c.followers)} followers</span></>}
              </div>
            </div>

            {c.overall_score != null && (
              <span className="text-xs font-medium tabular-nums text-muted-foreground w-8 text-right shrink-0">
                {c.overall_score.toFixed(1)}
              </span>
            )}

            <Button
              size="sm"
              variant={isAdded ? "ghost" : "secondary"}
              disabled={isAdded || pending}
              onClick={() => handleAdd(c.username)}
              className="shrink-0"
            >
              {isAdded
                ? <><Check className="h-3.5 w-3.5 mr-1" />Added</>
                : <><Plus className="h-3.5 w-3.5 mr-1" />Add as seed</>
              }
            </Button>
          </div>
        );
      })}
    </div>
    </div>
  );
}
