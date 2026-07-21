"use client";
import { useState, useTransition } from "react";
import { Sparkles, Plus, X, ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { addSeed, markBadSeed } from "@/app/actions/seeds";
import { leadCategory, CATEGORY_LABELS } from "@/lib/leads/category";
import type { SeedCandidate } from "@/lib/seeds/recommend";

export function RecommendedSeeds({ candidates }: { candidates: SeedCandidate[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visible = candidates.filter((c) => !dismissed.has(c.username));

  if (visible.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Recommended source accounts
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Accounts already in your leads that look like good seeds — ranked by business type,
          ICP fit, following size, and overlap with your existing seeds. Nothing here is
          added automatically.
        </p>
      </CardHeader>
      <CardContent className="p-0 divide-y">
        {visible.map((c) => (
          <CandidateRow key={c.username} candidate={c} onHandled={() => setDismissed((d) => new Set(d).add(c.username))} />
        ))}
      </CardContent>
    </Card>
  );
}

function CandidateRow({ candidate, onHandled }: { candidate: SeedCandidate; onHandled: () => void }) {
  const c = candidate;
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const category = leadCategory(c.business_model);

  const addAsSeed = () =>
    start(async () => {
      setMsg(null);
      const fd = new FormData();
      fd.append("input", c.username);
      // Already known from this lead's own row — carries straight over so the
      // new seed row doesn't show "following count unknown" for an account
      // we've already scraped and have this figure for.
      if (c.following != null) fd.append("following_count", String(c.following));
      const res = await addSeed(fd);
      if ("error" in res && res.error) { setMsg(`Error: ${res.error}`); return; }
      setMsg("Added as a source account.");
      onHandled();
    });

  const confirmBad = () =>
    start(async () => {
      setMsg(null);
      const res = await markBadSeed(c.username);
      if (!res.ok) { setMsg(`Error: ${res.error}`); return; }
      onHandled();
    });

  if (msg) {
    return <div className="px-4 py-2.5 text-xs text-muted-foreground">@{c.username} — {msg}</div>;
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <a
            href={`https://www.instagram.com/${c.username}/`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-sm hover:underline flex items-center gap-1"
          >
            @{c.username}
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </a>
          <Badge variant="secondary" className="text-[10px]">{CATEGORY_LABELS[category]}</Badge>
          {c.seedOverlap > 1 && (
            <Badge variant="outline" className="text-[10px]" title="Followed by more than one of your existing seeds">
              overlaps {c.seedOverlap} seeds
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {c.full_name ?? c.niche ?? c.business_model}
          {c.followers != null && ` · ${c.followers.toLocaleString()} followers`}
          {c.following != null && ` · follows ${c.following.toLocaleString()}`}
          {c.icp_fit_score != null && ` · ICP ${c.icp_fit_score}`}
          {c.foundViaSeed && ` · found via @${c.foundViaSeed}`}
        </p>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {confirming ? (
          <>
            <Button size="sm" variant="destructive" disabled={pending} onClick={confirmBad}>
              Mark bad
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={pending} onClick={addAsSeed}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add as seed
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirming(true)}
              title="Mark as a bad seed candidate"
              aria-label="Mark as a bad seed candidate"
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
