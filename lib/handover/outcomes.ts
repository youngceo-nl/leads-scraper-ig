import { createAdminClient } from "@/lib/supabase/admin";

export type HandoverOutcome = {
  accepted: number;
  noEmail: number;
  markedBad: number;
};

type OutcomeRow = { parent_username: string; accepted: number; no_email: number; marked_bad: number };

/**
 * Per-account results from the Clay handover round-trip — a different
 * question from the scrape -> backfill -> AI-score pipeline (see
 * lib/handover/overview.ts / lead_counts_by_parent), so it's its own small
 * query rather than folded into that already-shared aggregate.
 *
 * Powers the source-account tag's hover popover on Outreach Ready: while
 * fixing a lead's program name, the operator can see how the account it came
 * from actually did in Clay.
 */
export async function getHandoverOutcomesByParent(): Promise<Map<string, HandoverOutcome>> {
  const sb = createAdminClient();
  const { data } = await sb.rpc("handover_outcomes_by_parent");

  return new Map(
    ((data ?? []) as OutcomeRow[]).map((row) => [
      row.parent_username,
      { accepted: Number(row.accepted), noEmail: Number(row.no_email), markedBad: Number(row.marked_bad) },
    ]),
  );
}
