"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type State = Record<string, string | undefined>;

export function LeadsFilterBar({ initial }: { initial: State }) {
  const router = useRouter();
  const [s, setS] = useState<State>(initial);

  const set = (k: string, v: string | undefined) => setS((p) => ({ ...p, [k]: v || undefined, page: undefined }));

  const apply = () => {
    const params = new URLSearchParams();
    Object.entries(s).forEach(([k, v]) => { if (v) params.set(k, v); });
    router.push(`/leads?${params.toString()}`);
  };

  const clear = () => {
    setS({});
    router.push("/leads");
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      <Field label="Keywords (comma-separated, OR match)" hint="Matches username, full name, bio, niche">
        <Input value={s.q ?? ""} placeholder="coach, course, agency…" onChange={(e) => set("q", e.target.value)} />
      </Field>

      <Field label="Status">
        <Select value={s.status ?? "all"} onValueChange={(v) => set("status", v === "all" ? undefined : v)}>
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
        <Select value={s.business_model ?? "any"} onValueChange={(v) => set("business_model", v === "any" ? undefined : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {["any","course","coaching","agency","ecom","saas","creator","unknown"].map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Niche contains">
        <Input value={s.niche ?? ""} onChange={(e) => set("niche", e.target.value)} />
      </Field>

      <Field label="Min followers">
        <Input type="number" value={s.min_followers ?? ""} onChange={(e) => set("min_followers", e.target.value)} />
      </Field>
      <Field label="Max followers">
        <Input type="number" value={s.max_followers ?? ""} onChange={(e) => set("max_followers", e.target.value)} />
      </Field>
      <Field label="Min engagement % ">
        <Input type="number" step="0.1" value={s.min_engagement ?? ""} onChange={(e) => set("min_engagement", e.target.value)} />
      </Field>
      <Field label="Min posts last 30d">
        <Input type="number" value={s.min_posts_30d ?? ""} onChange={(e) => set("min_posts_30d", e.target.value)} />
      </Field>

      <Field label="Min score">
        <Input type="number" step="0.1" value={s.min_score ?? ""} onChange={(e) => set("min_score", e.target.value)} />
      </Field>

      <Field label="Offer platform">
        <Select value={s.funnel_platform ?? "any"} onValueChange={(v) => set("funnel_platform", v === "any" ? undefined : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {["any","linktree","stan","beacons","clickfunnels","kajabi","systeme","gohighlevel","shopify","wordpress","wix","squarespace","thrivecart","podia","teachable","thinkific","custom","unknown"].map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has an offer">
        <Select value={s.has_funnel ?? "any"} onValueChange={(v) => set("has_funnel", v === "any" ? undefined : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has an offer</SelectItem>
            <SelectItem value="no">No offer</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has email">
        <Select value={s.has_email ?? "any"} onValueChange={(v) => set("has_email", v === "any" ? undefined : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has email</SelectItem>
            <SelectItem value="no">No email</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has LinkedIn">
        <Select value={s.has_linkedin ?? "any"} onValueChange={(v) => set("has_linkedin", v === "any" ? undefined : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has LinkedIn</SelectItem>
            <SelectItem value="no">No LinkedIn</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Has YouTube">
        <Select value={s.has_youtube ?? "any"} onValueChange={(v) => set("has_youtube", v === "any" ? undefined : v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="yes">Has YouTube</SelectItem>
            <SelectItem value="no">No YouTube</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Sort by">
        <Select value={s.sort ?? "overall_score.desc"} onValueChange={(v) => set("sort", v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="overall_score.desc">Score (high → low)</SelectItem>
            <SelectItem value="overall_score.asc">Score (low → high)</SelectItem>
            <SelectItem value="followers.desc">Followers (high → low)</SelectItem>
            <SelectItem value="engagement_rate.desc">Engagement (high → low)</SelectItem>
            <SelectItem value="created_at.desc">Newest first</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <div className="flex items-end gap-2 md:col-span-2">
        <Button onClick={apply}>Apply filters</Button>
        <Button variant="outline" onClick={clear}>Clear</Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
