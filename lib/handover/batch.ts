import { createAdminClient } from "@/lib/supabase/admin";
import { BATCH_SIZE, parseEnrichedCsv, toClipboardText, type HandoverLead } from "@/lib/handover/format";

export class HandoverError extends Error {}

/** Columns a handed-over lead needs, both for the Clay export and the UI. */
const LEAD_FIELDS = "id, username, full_name, niche, external_link, profile_url, bio";

export type OpenBatch = {
  id: string;
  created_at: string;
  leads: HandoverLead[];
  enrichedCount: number;
};

// Leads eligible for handover, scoped to the account whose following list they
// came from (parent_username, not the originating seed): qualified, but
// with no email from either discovery pass. Finding those missing emails is
// exactly what the Clay waterfall is for — anything already reachable
// shouldn't burn credits.
// Kept as two inline chains rather than a shared helper: threading Supabase's
// builder generics through a wrapper trips the type instantiation depth limit.

export async function getPoolCount(parentUsername: string): Promise<number> {
  const sb = createAdminClient();
  const { count } = await sb
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("parent_username", parentUsername)
    .eq("status", "qualified")
    .is("email", null)
    .is("email_v2", null)
    .is("handover_batch_id", null);
  return count ?? 0;
}

export async function getOpenBatch(parentUsername: string): Promise<OpenBatch | null> {
  const sb = createAdminClient();

  const { data: batch } = await sb
    .from("handover_batches")
    .select("id, created_at")
    .eq("parent_username", parentUsername)
    .eq("status", "open")
    .maybeSingle();
  if (!batch) return null;

  const { data: leads } = await sb
    .from("leads")
    .select(`${LEAD_FIELDS}, handover_enriched_at, email`)
    .eq("handover_batch_id", batch.id)
    .order("username");

  return {
    id: batch.id,
    created_at: batch.created_at,
    leads: (leads ?? []) as HandoverLead[],
    enrichedCount: (leads ?? []).filter((l) => l.handover_enriched_at).length,
  };
}

/**
 * Opens a batch for one source account and moves up to BATCH_SIZE of its pool
 * leads into it, highest-scoring first so the best leads get enriched soonest.
 *
 * The one-open-batch-per-parent unique index is what actually prevents a
 * double-claim; the check here just turns that race into a readable message.
 *
 * Returns `copyText` alongside the batch so claiming and copying happen as one
 * action in the UI — nothing extra to fetch between "open a batch" and "put it
 * on the clipboard".
 */
export async function claimBatch(parentUsername: string): Promise<{ id: string; count: number; copyText: string }> {
  const sb = createAdminClient();

  if (await getOpenBatch(parentUsername)) {
    throw new HandoverError("A batch is already open for this account. Close it before claiming another.");
  }

  const { data: pool } = await sb
    .from("leads")
    .select("id, username, full_name, profile_url, bio")
    .eq("parent_username", parentUsername)
    .eq("status", "qualified")
    .is("email", null)
    .is("email_v2", null)
    .is("handover_batch_id", null)
    .order("overall_score", { ascending: false, nullsFirst: false })
    .limit(BATCH_SIZE);

  const claimed = pool ?? [];
  if (!claimed.length) throw new HandoverError("No qualified leads from this account are waiting for an email.");
  const ids = claimed.map((lead) => lead.id);

  const { data: batch, error } = await sb
    .from("handover_batches")
    .insert({ parent_username: parentUsername, status: "open" })
    .select("id")
    .single();
  if (error || !batch) {
    throw new HandoverError(
      error?.code === "23505"
        ? "A batch is already open for this account. Close it before claiming another."
        : (error?.message ?? "Could not open a batch."),
    );
  }

  const { error: assignError } = await sb
    .from("leads")
    .update({ handover_batch_id: batch.id })
    .in("id", ids)
    .is("handover_batch_id", null);

  if (assignError) {
    // Leave no empty batch behind holding the one-open slot.
    await sb.from("handover_batches").delete().eq("id", batch.id);
    throw new HandoverError(assignError.message);
  }

  return { id: batch.id, count: ids.length, copyText: toClipboardText(claimed) };
}

/**
 * Applies one returned Clay export across *every* open batch at once, rather
 * than one account at a time. The clipboard export is just bare handles, so
 * rows are matched to dispatched leads by username (unique in the leads
 * table) — this is also what lets one upload correctly fan out across
 * accounts without the operator having to split the CSV back apart per seed.
 *
 * Rows that don't match a currently-dispatched lead are skipped (reported,
 * not fatal) — e.g. leftovers from a stale export. Any batch that ends up
 * fully enriched by this import is auto-closed, which is how the page-lock
 * (`getDispatchState`) clears without a separate "Close" click.
 */
export async function applyEnrichmentAll(
  csvText: string,
): Promise<{ withEmail: number; withoutEmail: number; skipped: number; closedBatches: number }> {
  const sb = createAdminClient();
  const rows = parseEnrichedCsv(csvText);

  const { data: openBatches } = await sb
    .from("handover_batches")
    .select("id, parent_username")
    .eq("status", "open");
  const batchIds = (openBatches ?? []).map((b) => b.id);
  if (!batchIds.length) throw new HandoverError("There are no open batches to return leads to.");

  const { data: dispatched } = await sb
    .from("leads")
    .select("id, username, handover_batch_id")
    .in("handover_batch_id", batchIds);

  const byUsername = new Map((dispatched ?? []).map((lead) => [lead.username, lead]));

  const now = new Date().toISOString();
  let withEmail = 0;
  let withoutEmail = 0;
  let skipped = 0;
  const touchedBatchIds = new Set<string>();

  for (const row of rows) {
    const lead = byUsername.get(row.username);
    if (!lead) { skipped++; continue; }

    // Stamped even when Clay found nothing, so the lead counts as attempted
    // and doesn't cycle straight back into the pool on close.
    const patch: Record<string, unknown> = { handover_enriched_at: now };
    if (row.email) {
      Object.assign(patch, {
        email: row.email,
        email_provider: "clay",
        email_status: "found",
        enriched_at: now,
      });
      withEmail++;
    } else {
      withoutEmail++;
    }

    const { error } = await sb.from("leads").update(patch).eq("id", lead.id);
    if (error) throw new HandoverError(error.message);
    if (lead.handover_batch_id) touchedBatchIds.add(lead.handover_batch_id);
  }

  let closedBatches = 0;
  for (const batchId of touchedBatchIds) {
    const { count: remaining } = await sb
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("handover_batch_id", batchId)
      .is("handover_enriched_at", null);
    if ((remaining ?? 0) === 0) {
      await sb.from("handover_batches").update({ status: "closed", closed_at: now }).eq("id", batchId);
      closedBatches++;
    }
  }

  return { withEmail, withoutEmail, skipped, closedBatches };
}

/**
 * Closes the open batch. Leads Clay never came back on return to the pool so a
 * later batch can retry them; enriched ones stay attached as a record.
 */
export async function closeBatch(parentUsername: string): Promise<{ returnedToPool: number }> {
  const sb = createAdminClient();

  const batch = await getOpenBatch(parentUsername);
  if (!batch) throw new HandoverError("There is no open batch for this account.");

  const { data: returned, error } = await sb
    .from("leads")
    .update({ handover_batch_id: null })
    .eq("handover_batch_id", batch.id)
    .is("handover_enriched_at", null)
    .select("id");
  if (error) throw new HandoverError(error.message);

  await sb
    .from("handover_batches")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", batch.id);

  return { returnedToPool: returned?.length ?? 0 };
}

export type DispatchBatch = {
  parentUsername: string;
  total: number;
  enriched: number;
  /** Re-copy affordance — the page-lock panel stays interactive even though everything behind it is locked. */
  copyText: string;
};

export type DispatchState = {
  /** True while any open batch still has un-enriched dispatched leads. */
  locked: boolean;
  batches: DispatchBatch[];
};

/**
 * Whole-page-lock signal: as long as leads are out with Clay and not fully
 * back, the leads page should be non-interactable. Derived entirely from
 * `handover_batches.status` + `leads.handover_enriched_at` — no separate
 * "dispatched" flag to keep in sync.
 */
export async function getDispatchState(): Promise<DispatchState> {
  const sb = createAdminClient();

  const { data: openBatches } = await sb
    .from("handover_batches")
    .select("id, parent_username")
    .eq("status", "open");
  if (!openBatches?.length) return { locked: false, batches: [] };

  const ids = openBatches.map((b) => b.id);
  const { data: leads } = await sb
    .from("leads")
    .select("username, full_name, profile_url, bio, handover_batch_id, handover_enriched_at")
    .in("handover_batch_id", ids);

  const batches = openBatches
    .map((b) => {
      const batchLeads = (leads ?? []).filter((l) => l.handover_batch_id === b.id);
      return {
        parentUsername: b.parent_username,
        total: batchLeads.length,
        enriched: batchLeads.filter((l) => l.handover_enriched_at).length,
        copyText: toClipboardText(batchLeads),
      };
    })
    // A batch with nothing dispatched yet (shouldn't happen — claimBatch always
    // assigns at least one lead — but defensive against a race mid-claim).
    .filter((b) => b.total > 0);

  return { locked: batches.some((b) => b.enriched < b.total), batches };
}
