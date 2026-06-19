"use client";
import { useEffect, useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateLead, type LeadPatch } from "@/app/actions/leads";
import type { LeadEditPayload } from "./double-click-row";

export function LeadEditDialog() {
  const [lead, setLead] = useState<LeadEditPayload | null>(null);
  const [draft, setDraft] = useState<LeadPatch>({});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<LeadEditPayload>).detail;
      setLead(payload);
      setDraft({
        full_name: payload.full_name,
        email: payload.email,
        niche: payload.niche,
        bio: payload.bio,
        external_link: payload.external_link,
        funnel_program_name: payload.funnel_program_name,
      });
      setError(null);
      setTimeout(() => firstRef.current?.focus(), 0);
    };
    window.addEventListener("edit-lead", handler);
    return () => window.removeEventListener("edit-lead", handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!lead) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setLead(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lead]);

  const save = () => {
    if (!lead) return;
    setError(null);
    start(async () => {
      const r = await updateLead(lead.leadId, draft);
      if (r.ok) {
        setLead(null);
        router.refresh();
      } else {
        setError(r.error ?? "Save failed");
      }
    });
  };

  if (!lead) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setLead(null); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div className="relative z-10 bg-background border rounded-lg shadow-xl w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Edit lead</h2>
          <button
            type="button"
            onClick={() => setLead(null)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Full name</Label>
            <Input
              ref={firstRef}
              value={draft.full_name ?? ""}
              onChange={e => setDraft(d => ({ ...d, full_name: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && save()}
              placeholder="Jane Doe"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Email</Label>
            <Input
              type="email"
              value={draft.email ?? ""}
              onChange={e => setDraft(d => ({ ...d, email: e.target.value }))}
              placeholder="jane@example.com"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Niche</Label>
            <Input
              value={draft.niche ?? ""}
              onChange={e => setDraft(d => ({ ...d, niche: e.target.value }))}
              placeholder="fitness, business coaching…"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Program name</Label>
            <Input
              value={draft.funnel_program_name ?? ""}
              onChange={e => setDraft(d => ({ ...d, funnel_program_name: e.target.value }))}
              placeholder="e.g. Elite Mastermind"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Bio link</Label>
            <Input
              value={draft.external_link ?? ""}
              onChange={e => setDraft(d => ({ ...d, external_link: e.target.value }))}
              placeholder="https://…"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Bio</Label>
            <Textarea
              value={draft.bio ?? ""}
              onChange={e => setDraft(d => ({ ...d, bio: e.target.value }))}
              rows={4}
              className="text-sm resize-none"
              placeholder="Instagram bio…"
            />
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setLead(null)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
