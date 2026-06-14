"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { ArrowDown, ArrowUp, X } from "lucide-react";

type State = Record<string, string | undefined>;

// Sortable fields with plain-language labels for each direction, so the user
// picks "what to sort by" and the toggle spells out what asc/desc actually mean.
const SORT_FIELDS = [
  { value: "overall_score", label: "Score", descLabel: "High → low", ascLabel: "Low → high" },
  { value: "created_at", label: "Date added", descLabel: "Newest first", ascLabel: "Oldest first" },
  { value: "followers", label: "Followers", descLabel: "Most first", ascLabel: "Fewest first" },
  { value: "engagement_rate", label: "Engagement", descLabel: "High → low", ascLabel: "Low → high" },
  { value: "posts_last_30_days", label: "Posts (last 30d)", descLabel: "Most first", ascLabel: "Fewest first" },
  { value: "username", label: "Username", descLabel: "Z → A", ascLabel: "A → Z" },
] as const;

const DEFAULT_SORT = "overall_score.desc";

const FOLLOWERS_MAX = 1_000_000;
const FOLLOWERS_STEP = 1_000;
const ENGAGEMENT_MAX = 20; // percent
const POSTS_MAX = 60;
const SCORE_MAX = 10;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const fmt = (n: number) => n.toLocaleString("en-US");
const numOr = (v: string | undefined, d: number) => {
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function LeadsFilterBar({ initial }: { initial: State }) {
  const router = useRouter();
  const [s, setS] = useState<State>(initial);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const commitNow = (next: State) => {
    const params = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) params.set(k, v); });
    const qs = params.toString();
    router.push(qs ? `/leads?${qs}` : "/leads");
  };

  // Update state + apply instantly (selects, sliders-on-release, toggles).
  const apply = (patch: Partial<State>) => {
    const next: State = { ...s, ...patch, page: undefined };
    setS(next);
    commitNow(next);
  };

  // Update state immediately (for a responsive input) but defer the navigation
  // so we don't push on every keystroke / drag tick.
  const applyDebounced = (patch: Partial<State>, ms = 400) => {
    const next: State = { ...s, ...patch, page: undefined };
    setS(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitNow(next), ms);
  };

  // Stage transient state without navigating (used while dragging a slider).
  const stage = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch, page: undefined }));

  const clear = () => { setS({}); router.push("/leads"); };

  // ---- Sort ----
  const [sortField, sortDirRaw] = (s.sort ?? DEFAULT_SORT).split(".");
  const sortMeta = SORT_FIELDS.find((f) => f.value === sortField) ?? SORT_FIELDS[0];
  const sortDir: "asc" | "desc" = sortDirRaw === "asc" ? "asc" : "desc";
  const setSort = (field: string, dir: "asc" | "desc") => apply({ sort: `${field}.${dir}` });

  // ---- Range slider values ----
  const fMin = clamp(numOr(s.min_followers, 0), 0, FOLLOWERS_MAX);
  const fMax = clamp(numOr(s.max_followers, FOLLOWERS_MAX), 0, FOLLOWERS_MAX);
  const engagement = clamp(numOr(s.min_engagement, 0), 0, ENGAGEMENT_MAX);
  const posts = clamp(numOr(s.min_posts_30d, 0), 0, POSTS_MAX);
  const score = clamp(numOr(s.min_score, 0), 0, SCORE_MAX);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-4">
      <Field label="Keywords (comma-separated, OR match)" hint="Matches username, full name, bio, niche" className="md:col-span-2">
        <Input value={s.q ?? ""} placeholder="coach, course, agency…" onChange={(e) => applyDebounced({ q: e.target.value || undefined })} />
      </Field>

      <Field label="Niche contains">
        <Input value={s.niche ?? ""} onChange={(e) => applyDebounced({ niche: e.target.value || undefined })} />
      </Field>

      <Field label="Status">
        <Select value={s.status ?? "all"} onValueChange={(v) => apply({ status: v === "all" ? undefined : v })}>
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
        <Select value={s.business_model ?? "any"} onValueChange={(v) => apply({ business_model: v === "any" ? undefined : v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {["any","course","coaching","agency","ecom","saas","creator","unknown"].map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label={`Followers: ${fMin === 0 ? "0" : fmt(fMin)} – ${fMax >= FOLLOWERS_MAX ? "1M+" : fmt(fMax)}`} className="md:col-span-2">
        <Slider
          min={0}
          max={FOLLOWERS_MAX}
          step={FOLLOWERS_STEP}
          value={[fMin, fMax]}
          onValueChange={([min, max]) => stage({ min_followers: String(min), max_followers: String(max) })}
          onValueCommit={([min, max]) => apply({
            min_followers: min > 0 ? String(min) : undefined,
            max_followers: max < FOLLOWERS_MAX ? String(max) : undefined,
          })}
        />
      </Field>

      <Field label={`Min engagement: ${engagement === 0 ? "Any" : `${engagement}%`}`}>
        <Slider
          min={0}
          max={ENGAGEMENT_MAX}
          step={0.1}
          value={[engagement]}
          onValueChange={([v]) => stage({ min_engagement: String(v) })}
          onValueCommit={([v]) => apply({ min_engagement: v > 0 ? String(v) : undefined })}
        />
      </Field>

      <Field label={`Min posts (30d): ${posts === 0 ? "Any" : posts}`}>
        <Slider
          min={0}
          max={POSTS_MAX}
          step={1}
          value={[posts]}
          onValueChange={([v]) => stage({ min_posts_30d: String(v) })}
          onValueCommit={([v]) => apply({ min_posts_30d: v > 0 ? String(v) : undefined })}
        />
      </Field>

      <Field label={`Min score: ${score === 0 ? "Any" : score}`}>
        <Slider
          min={0}
          max={SCORE_MAX}
          step={0.5}
          value={[score]}
          onValueChange={([v]) => stage({ min_score: String(v) })}
          onValueCommit={([v]) => apply({ min_score: v > 0 ? String(v) : undefined })}
        />
      </Field>

      <Field label="Offer platform">
        <Select value={s.funnel_platform ?? "any"} onValueChange={(v) => apply({ funnel_platform: v === "any" ? undefined : v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {["any","linktree","stan","beacons","clickfunnels","kajabi","systeme","gohighlevel","shopify","wordpress","wix","squarespace","thrivecart","podia","teachable","thinkific","custom","unknown"].map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has an offer">
        <Select value={s.has_funnel ?? "any"} onValueChange={(v) => apply({ has_funnel: v === "any" ? undefined : v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has an offer</SelectItem>
            <SelectItem value="no">No offer</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has email">
        <Select value={s.has_email ?? "any"} onValueChange={(v) => apply({ has_email: v === "any" ? undefined : v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has email</SelectItem>
            <SelectItem value="no">No email</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has LinkedIn">
        <Select value={s.has_linkedin ?? "any"} onValueChange={(v) => apply({ has_linkedin: v === "any" ? undefined : v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has LinkedIn</SelectItem>
            <SelectItem value="no">No LinkedIn</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has YouTube">
        <Select value={s.has_youtube ?? "any"} onValueChange={(v) => apply({ has_youtube: v === "any" ? undefined : v })}>
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
          <Select value={sortMeta.value} onValueChange={(v) => setSort(v, sortDir)}>
            <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SORT_FIELDS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="shrink-0 gap-1.5 whitespace-nowrap font-normal"
            title="Toggle sort direction"
            onClick={() => setSort(sortMeta.value, sortDir === "desc" ? "asc" : "desc")}
          >
            {sortDir === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
            {sortDir === "desc" ? sortMeta.descLabel : sortMeta.ascLabel}
          </Button>
        </div>
      </Field>

      <div className="flex items-end md:col-span-2">
        <Button variant="ghost" size="sm" onClick={clear} className="text-muted-foreground">
          <X className="h-3.5 w-3.5 mr-1" /> Clear all filters
        </Button>
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
