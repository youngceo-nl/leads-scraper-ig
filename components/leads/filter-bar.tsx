"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { ArrowDown, ArrowUp, X } from "lucide-react";

type State = Record<string, string | undefined>;

const SORT_FIELDS = [
  { value: "overall_score",    label: "Score",           descLabel: "High → low",    ascLabel: "Low → high" },
  { value: "created_at",       label: "Date added",      descLabel: "Newest first",  ascLabel: "Oldest first" },
  { value: "followers",        label: "Followers",       descLabel: "Most first",    ascLabel: "Fewest first" },
  { value: "engagement_rate",  label: "Engagement",      descLabel: "High → low",    ascLabel: "Low → high" },
  { value: "posts_last_30_days", label: "Posts (last 30d)", descLabel: "Most first", ascLabel: "Fewest first" },
  { value: "username",         label: "Username",        descLabel: "Z → A",         ascLabel: "A → Z" },
] as const;

const DEFAULT_SORT   = "overall_score.desc";
const STORAGE_KEY    = "leads:filters";
const FOLLOWERS_MAX  = 1_000_000;
const FOLLOWERS_STEP = 1_000;
const ENGAGEMENT_MAX = 20;
const POSTS_MAX      = 60;
const SCORE_MAX      = 10;

const clamp  = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const fmt    = (n: number) => n.toLocaleString("en-US");
const numOr  = (v: string | undefined, d: number) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : d; };

export function LeadsFilterBar({ initial }: { initial: State }) {
  const router = useRouter();

  // `staged` = what the user has set in the UI (may differ from URL / applied state)
  const [staged, setStaged] = useState<State>(initial);

  // On mount with no URL params → restore last saved filter from localStorage
  useEffect(() => {
    if (Object.keys(initial).length > 0) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as State;
      setStaged(saved);
      const params = new URLSearchParams();
      Object.entries(saved).forEach(([k, v]) => { if (v) params.set(k, v); });
      const qs = params.toString();
      if (qs) router.replace(`/leads?${qs}`);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stage = (patch: Partial<State>) =>
    setStaged(p => ({ ...p, ...patch, page: undefined }));

  const applyNow = (overrideState?: State) => {
    const next = overrideState ?? staged;
    const params = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) params.set(k, v); });
    const qs = params.toString();
    router.push(qs ? `/leads?${qs}` : "/leads");
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const clear = () => {
    const empty: State = {};
    setStaged(empty);
    router.push("/leads");
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  };

  // ---- Sort ----
  const [sortField, sortDirRaw] = (staged.sort ?? DEFAULT_SORT).split(".");
  const sortMeta = SORT_FIELDS.find(f => f.value === sortField) ?? SORT_FIELDS[0];
  const sortDir: "asc" | "desc" = sortDirRaw === "asc" ? "asc" : "desc";

  // ---- Slider display values ----
  const fMin       = clamp(numOr(staged.min_followers,  0),            0, FOLLOWERS_MAX);
  const fMax       = clamp(numOr(staged.max_followers,  FOLLOWERS_MAX), 0, FOLLOWERS_MAX);
  const engagement = clamp(numOr(staged.min_engagement, 0),            0, ENGAGEMENT_MAX);
  const posts      = clamp(numOr(staged.min_posts_30d,  0),            0, POSTS_MAX);
  const score      = clamp(numOr(staged.min_score,      0),            0, SCORE_MAX);

  // Check if staged state differs from the URL (initial) state
  const isDirty = JSON.stringify(staged) !== JSON.stringify(initial);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-4">
        <Field label="Keywords (comma-separated, OR match)" hint="Matches username, full name, bio, niche" className="md:col-span-2">
          <Input value={staged.q ?? ""} placeholder="coach, course, agency…" onChange={e => stage({ q: e.target.value || undefined })} />
        </Field>

        <Field label="Niche contains">
          <Input value={staged.niche ?? ""} onChange={e => stage({ niche: e.target.value || undefined })} />
        </Field>

        <Field label="Status">
          <Select value={staged.status ?? "all"} onValueChange={v => stage({ status: v === "all" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="qualified">Qualified</SelectItem>
              <SelectItem value="review">Needs review</SelectItem>
              <SelectItem value="rejected">Not a fit</SelectItem>
              <SelectItem value="pending">Not analyzed yet</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Business model">
          <Select value={staged.business_model ?? "any"} onValueChange={v => stage({ business_model: v === "any" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["any","course","coaching","agency","ecom","saas","creator","unknown"].map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={`Followers: ${fMin === 0 ? "0" : fmt(fMin)} – ${fMax >= FOLLOWERS_MAX ? "1M+" : fmt(fMax)}`} className="md:col-span-2">
          <Slider
            min={0} max={FOLLOWERS_MAX} step={FOLLOWERS_STEP} value={[fMin, fMax]}
            onValueChange={([min, max]) => stage({ min_followers: String(min), max_followers: String(max) })}
            onValueCommit={([min, max]) => stage({
              min_followers: min > 0 ? String(min) : undefined,
              max_followers: max < FOLLOWERS_MAX ? String(max) : undefined,
            })}
          />
        </Field>

        <Field label={`Min engagement: ${engagement === 0 ? "Any" : `${engagement}%`}`}>
          <Slider
            min={0} max={ENGAGEMENT_MAX} step={0.1} value={[engagement]}
            onValueChange={([v]) => stage({ min_engagement: String(v) })}
            onValueCommit={([v]) => stage({ min_engagement: v > 0 ? String(v) : undefined })}
          />
        </Field>

        <Field label={`Min posts (30d): ${posts === 0 ? "Any" : posts}`}>
          <Slider
            min={0} max={POSTS_MAX} step={1} value={[posts]}
            onValueChange={([v]) => stage({ min_posts_30d: String(v) })}
            onValueCommit={([v]) => stage({ min_posts_30d: v > 0 ? String(v) : undefined })}
          />
        </Field>

        <Field label={`Min score: ${score === 0 ? "Any" : score}`}>
          <Slider
            min={0} max={SCORE_MAX} step={0.5} value={[score]}
            onValueChange={([v]) => stage({ min_score: String(v) })}
            onValueCommit={([v]) => stage({ min_score: v > 0 ? String(v) : undefined })}
          />
        </Field>

        <Field label="Offer platform">
          <Select value={staged.funnel_platform ?? "any"} onValueChange={v => stage({ funnel_platform: v === "any" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["any","linktree","stan","beacons","clickfunnels","kajabi","systeme","gohighlevel","shopify","wordpress","wix","squarespace","thrivecart","podia","teachable","thinkific","custom","unknown"].map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has an offer">
          <Select value={staged.has_funnel ?? "any"} onValueChange={v => stage({ has_funnel: v === "any" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has an offer</SelectItem>
              <SelectItem value="no">No offer</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has email">
          <Select value={staged.has_email ?? "any"} onValueChange={v => stage({ has_email: v === "any" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has email</SelectItem>
              <SelectItem value="no">No email</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has LinkedIn">
          <Select value={staged.has_linkedin ?? "any"} onValueChange={v => stage({ has_linkedin: v === "any" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has LinkedIn</SelectItem>
              <SelectItem value="no">No LinkedIn</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has YouTube">
          <Select value={staged.has_youtube ?? "any"} onValueChange={v => stage({ has_youtube: v === "any" ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has YouTube</SelectItem>
              <SelectItem value="no">No YouTube</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Sort by" className="md:col-span-2">
          <div className="flex gap-2">
            <Select value={sortMeta.value} onValueChange={v => stage({ sort: `${v}.${sortDir}` })}>
              <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SORT_FIELDS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 gap-1.5 whitespace-nowrap font-normal"
              onClick={() => stage({ sort: `${sortMeta.value}.${sortDir === "desc" ? "asc" : "desc"}` })}
            >
              {sortDir === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
              {sortDir === "desc" ? sortMeta.descLabel : sortMeta.ascLabel}
            </Button>
          </div>
        </Field>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={() => applyNow()} disabled={!isDirty}>
          Apply filters
        </Button>
        <Button variant="ghost" size="sm" onClick={clear} className="text-muted-foreground">
          <X className="h-3.5 w-3.5 mr-1" /> Clear all filters
        </Button>
        {isDirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1${className ? ` ${className}` : ""}`}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
