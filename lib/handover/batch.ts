import { createAdminClient } from "@/lib/supabase/admin";
import { BATCH_SIZE, parseEnrichedCsv, type HandoverLead } from "@/lib/handover/format";

export class HandoverError extends Error {}

/** Columns a handed-over lead needs, both for the Clay export and the UI. */
const LEAD_FIELDS = "id, username, full_name, niche, external_link, profile_url";

export type OpenBatch = {
  id: string;
  created_at: string;
  leads: HandoverLead[];
  enrichedCount: number;
};

// Leads eligible for handover: qualified, but with no email from either
// discovery pass. Finding those missing emails is exactly what the Clay
// waterfall is for — anything already reachable shouldn't burn credits.
// Kept as two inline chains rather than a shared helper: threading Supabase's
// builder generics through a wrapper trips the type instantiation depth limit.

export async function getPoolCount(): Promise<number> {
  const sb = createAdminClient();
  const { count } = await sb
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "qualified")
    .is("email", null)
    .is("email_v2", null)
    .is("handover_batch_id", null);
  return count ?? 0;
}

export async function getOpenBatch(): Promise<OpenBatch | null> {
  const sb = createAdminClient();

  const { data: batch } = await sb
    .from("handover_batches")
    .select("id, created_at")
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
 * Opens a batch and moves up to BATCH_SIZE pool leads into it, highest-scoring
 * first so the best leads get enriched soonest.
 *
 * The one-open-batch unique index is what actually prevents a double-claim;
 * the check here just turns that race into a readable message.
 */
export async function claimBatch(): Promise<{ id: string; count: number }> {
  const sb = createAdminClient();

  if (await getOpenBatch()) {
    throw new HandoverError("A batch is already open. Close it before claiming another.");
  }

  const { data: pool } = await sb
    .from("leads")
    .select("id")
    .eq("status", "qualified")
    .is("email", null)
    .is("email_v2", null)
    .is("handover_batch_id", null)
    .order("overall_score", { ascending: false, nullsFirst: false })
    .limit(BATCH_SIZE);

  const ids = (pool ?? []).map((lead) => lead.id);
  if (!ids.length) throw new HandoverError("No qualified leads are waiting for an email.");

  const { data: batch, error } = await sb
    .from("handover_batches")
    .insert({ status: "open" })
    .select("id")
    .single();
  if (error || !batch) {
    throw new HandoverError(
      error?.code === "23505"
        ? "A batch is already open. Close it before claiming another."
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

  return { id: batch.id, count: ids.length };
}

/**
 * Applies a Clay export to the open batch.
 *
 * Every row must belong to this batch; a file referencing anything else is
 * rejected outright rather than half-applied, because in practice that means
 * the wrong export was picked and a partial import would be worse than none.
 */
export async function applyEnrichment(
  csvText: string,
): Promise<{ withEmail: number; withoutEmail: number }> {
  const sb = createAdminClient();
  const rows = parseEnrichedCsv(csvText);

  const batch = await getOpenBatch();
  if (!batch) throw new HandoverError("There is no open batch to return leads to.");

  const inBatch = new Set(batch.leads.map((lead) => lead.id));
  const foreign = rows.filter((row) => !inBatch.has(row.leadId));
  if (foreign.length) {
    throw new HandoverError(
      `${foreign.length} of ${rows.length} rows are not in this batch (e.g. "${foreign[0].leadId}"). ` +
        "Nothing was imported — check you exported the right Clay table.",
    );
  }

  const now = new Date().toISOString();
  let withEmail = 0;

  for (const row of rows) {
    // Stamped even when Clay found nothing, so the lead counts as attempted and
    // doesn't cycle straight back into the pool on close.
    const patch: Record<string, unknown> = { handover_enriched_at: now };
    if (row.email) {
      Object.assign(patch, {
        email: row.email,
        email_provider: "clay",
        email_status: "found",
        enriched_at: now,
      });
      withEmail++;
    }

    const { error } = await sb.from("leads").update(patch).eq("id", row.leadId);
    if (error) throw new HandoverError(error.message);
  }

  return { withEmail, withoutEmail: rows.length - withEmail };
}

/**
 * Closes the open batch. Leads Clay never came back on return to the pool so a
 * later batch can retry them; enriched ones stay attached as a record.
 */
export async function closeBatch(): Promise<{ returnedToPool: number }> {
  const sb = createAdminClient();

  const batch = await getOpenBatch();
  if (!batch) throw new HandoverError("There is no open batch.");

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
