"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { buildLeadContext, renderTemplate } from "@/lib/outreach/template";
import type { LeadStatus } from "@/lib/types";
import { OutreachLeadRail } from "./outreach-lead-rail";
import { OutreachComposer } from "./outreach-composer";

export type OutreachRow = {
  id: string;
  username: string;
  full_name: string | null;
  niche: string | null;
  business_model: string | null;
  funnel_program_name: string | null;
  funnel_offer_summary: string | null;
  external_link: string | null;
  email: string;
  email_provider: string | null;
  overall_score: number | null;
  status: LeadStatus;
  firstName: string | null;
  needsFix: boolean;
};

export type Draft = { full_name: string; funnel_program_name: string };

export function OutreachReadyClient({
  rows,
  subjectTemplate,
  bodyTemplate,
  senderName,
  sentToday,
  dryRun,
}: {
  rows: OutreachRow[];
  subjectTemplate: string;
  bodyTemplate: string;
  senderName: string | null;
  sentToday: number;
  dryRun: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>(rows[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // A sent lead drops out of the server query on refresh; keep it visible for
  // the session so the rail doesn't silently reshuffle under the user.
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [needsFixOnly, setNeedsFixOnly] = useState(false);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];

  const draftFor = (row: OutreachRow): Draft =>
    drafts[row.id] ?? {
      full_name: row.full_name ?? "",
      funnel_program_name: row.funnel_program_name ?? "",
    };

  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => {
      const row = rows.find((r) => r.id === id);
      const base = d[id] ?? {
        full_name: row?.full_name ?? "",
        funnel_program_name: row?.funnel_program_name ?? "",
      };
      return { ...d, [id]: { ...base, ...patch } };
    });

  // The whole point of the screen: rendering is pure and synchronous, so the
  // subject and greeting update as the user types with no network round-trip.
  const rendered = useMemo(() => {
    if (!selected) return { subject: "", body: "" };
    const draft = drafts[selected.id] ?? {
      full_name: selected.full_name ?? "",
      funnel_program_name: selected.funnel_program_name ?? "",
    };
    const ctx = buildLeadContext({
      lead: {
        username: selected.username,
        full_name: draft.full_name || null,
        niche: selected.niche,
        business_model: selected.business_model,
        funnel_program_name: draft.funnel_program_name || null,
        funnel_offer_summary: selected.funnel_offer_summary,
        external_link: selected.external_link,
      },
      senderName,
    });
    return {
      subject: renderTemplate(subjectTemplate, ctx),
      body: renderTemplate(bodyTemplate, ctx),
      firstName: String(ctx.first_name ?? ""),
      programName: String(ctx.program_name ?? ""),
    };
  }, [selected, drafts, subjectTemplate, bodyTemplate, senderName]);

  const onSent = (id: string) => {
    setSentIds((s) => new Set(s).add(id));
    const remaining = rows.filter((r) => r.id !== id && !sentIds.has(r.id));
    if (remaining.length) setSelectedId(remaining[0].id);
    router.refresh();
  };

  const needsFixCount = rows.filter((r) => r.needsFix && !sentIds.has(r.id)).length;

  return (
    <div className="grid grid-cols-[300px_1fr] h-screen overflow-hidden">
      <OutreachLeadRail
        rows={rows}
        selectedId={selected?.id ?? ""}
        onSelect={setSelectedId}
        sentIds={sentIds}
        drafts={drafts}
        readyCount={rows.length - sentIds.size}
        needsFixCount={needsFixCount}
        sentToday={sentToday}
        needsFixOnly={needsFixOnly}
        onToggleNeedsFix={() => setNeedsFixOnly((v) => !v)}
      />
      {selected ? (
        <OutreachComposer
          key={selected.id}
          row={selected}
          draft={draftFor(selected)}
          onDraftChange={(patch) => setDraft(selected.id, patch)}
          subject={rendered.subject}
          body={rendered.body}
          firstName={rendered.firstName ?? ""}
          programName={rendered.programName ?? ""}
          senderName={senderName}
          alreadySent={sentIds.has(selected.id)}
          dryRun={dryRun}
          onSent={() => onSent(selected.id)}
        />
      ) : (
        <div className="flex items-center justify-center text-sm text-muted-foreground">
          Select a lead
        </div>
      )}
    </div>
  );
}
