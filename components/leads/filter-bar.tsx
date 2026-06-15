"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";

type State = Record<string, string | undefined>;

const STORAGE_KEY = "leads:filters";

export function LeadsFilterBar({ initial }: { initial: State }) {
  const router = useRouter();
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

  const set = (k: string, v: string | undefined) =>
    setStaged(p => ({ ...p, [k]: v || undefined, page: undefined }));

  const applyNow = (override?: State) => {
    const next = override ?? staged;
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

  const isDirty = JSON.stringify(staged) !== JSON.stringify(initial);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">

        <Field label="Keywords (comma-separated, OR match)" hint="Matches username, full name, bio, niche" className="md:col-span-2">
          <Input value={staged.q ?? ""} placeholder="coach, course, agency…" onChange={e => set("q", e.target.value)} />
        </Field>

        <Field label="Status">
          <Select value={staged.status ?? "all"} onValueChange={v => set("status", v === "all" ? undefined : v)}>
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
          <Select value={staged.business_model ?? "any"} onValueChange={v => set("business_model", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["any","course","coaching","agency","ecom","saas","creator","unknown"].map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Niche contains">
          <Input value={staged.niche ?? ""} onChange={e => set("niche", e.target.value)} />
        </Field>

        <Field label="Min followers">
          <Input type="number" value={staged.min_followers ?? ""} placeholder="e.g. 5000" onChange={e => set("min_followers", e.target.value)} />
        </Field>

        <Field label="Max followers">
          <Input type="number" value={staged.max_followers ?? ""} placeholder="e.g. 500000" onChange={e => set("max_followers", e.target.value)} />
        </Field>

        <Field label="Min engagement %">
          <Input type="number" step="0.1" value={staged.min_engagement ?? ""} placeholder="e.g. 2" onChange={e => set("min_engagement", e.target.value)} />
        </Field>

        <Field label="Min reels last 30d">
          <Input type="number" value={staged.min_reels_30d ?? ""} placeholder="e.g. 4" onChange={e => set("min_reels_30d", e.target.value)} />
        </Field>

        <Field label="Min score">
          <Input type="number" step="0.5" value={staged.min_score ?? ""} placeholder="e.g. 6" onChange={e => set("min_score", e.target.value)} />
        </Field>

        <Field label="Offer platform">
          <Select value={staged.funnel_platform ?? "any"} onValueChange={v => set("funnel_platform", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["any","linktree","stan","beacons","clickfunnels","kajabi","systeme","gohighlevel","shopify","wordpress","wix","squarespace","thrivecart","podia","teachable","thinkific","custom","unknown"].map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has an offer">
          <Select value={staged.has_funnel ?? "any"} onValueChange={v => set("has_funnel", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has an offer</SelectItem>
              <SelectItem value="no">No offer</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has email">
          <Select value={staged.has_email ?? "any"} onValueChange={v => set("has_email", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has email</SelectItem>
              <SelectItem value="no">No email</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has LinkedIn">
          <Select value={staged.has_linkedin ?? "any"} onValueChange={v => set("has_linkedin", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has LinkedIn</SelectItem>
              <SelectItem value="no">No LinkedIn</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Has YouTube">
          <Select value={staged.has_youtube ?? "any"} onValueChange={v => set("has_youtube", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Has YouTube</SelectItem>
              <SelectItem value="no">No YouTube</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Outreach">
          <Select value={staged.has_outreach ?? "any"} onValueChange={v => set("has_outreach", v === "any" ? undefined : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Contacted</SelectItem>
              <SelectItem value="no">Not yet contacted</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Sort by" className="md:col-span-2">
          <Select value={staged.sort ?? "overall_score.desc"} onValueChange={v => set("sort", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="overall_score.desc">Score (high → low)</SelectItem>
              <SelectItem value="overall_score.asc">Score (low → high)</SelectItem>
              <SelectItem value="followers.desc">Followers (high → low)</SelectItem>
              <SelectItem value="followers.asc">Followers (low → high)</SelectItem>
              <SelectItem value="engagement_rate.desc">Engagement (high → low)</SelectItem>
              <SelectItem value="reels_last_30_days.desc">Reels 30d (most first)</SelectItem>
              <SelectItem value="created_at.desc">Newest first</SelectItem>
              <SelectItem value="created_at.asc">Oldest first</SelectItem>
              <SelectItem value="username.asc">Username (A → Z)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={() => applyNow()} disabled={!isDirty}>Apply filters</Button>
        <Button variant="ghost" size="sm" onClick={clear} className="text-muted-foreground">
          <X className="h-3.5 w-3.5 mr-1" /> Clear all
        </Button>
        {isDirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
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
