import { createAdminClient } from "@/lib/supabase/admin";
import { toClipboardText, type HandoverLead } from "@/lib/handover/format";
import { getScrapedSeedIds } from "@/lib/seeds/scraped";

/** Bucket for leads with no parent account — imports, manual adds, depth-0 rows. */
export const UNATTRIBUTED = "(unattributed)";

/** Read-only row preview cap — bounds render cost for accounts with a large pool. */
const PREVIEW_LIMIT = 50;

export type AccountHandover = {
  /** parent_username, or UNATTRIBUTED. The key batches are opened against. */
  parentUsername: string;
  username: string;
  /** Qualified leads from this account that need an email — the account's work. */
  total: number;
  /** Of those, how many have been through a handover batch. */
  done: number;
  openBatch: {
    id: string;
    leads: (HandoverLead & { handover_enriched_at: string | null; email: string | null })[];
    copyText: string;
  } | null;
  /** Read-only preview of the pool for the expandable row — not the whole thing past PREVIEW_LIMIT. */
  poolLeads: { username: string; full_name: string | null }[];
  poolMore: number;
};

/**
 * One row per account whose following list produced leads, for the blocks on
 * the leads page.
 *
 * Grouped by `parent_username`, not `source_seed_id`. The latter means "the
 * seed this discovery traces back to" and survives recursion into other
 * accounts, so it reported @pierree as the source of 1039 leads when only 461
 * were his followings — the rest came from recursing into @bridger_rogers.
 *
 * `done` counts leads that have been *through* handover, not leads with an
 * email: Clay finds nothing for plenty of accounts, and this number shows how
 * far along an account is, not how well enrichment performed.
 */
export async function getAccountHandoverStats(): Promise<AccountHandover[]> {
  const sb = createAdminClient();

  const [{ data: leads }, { data: batches }, { data: seeds }, scrapedIds] = await Promise.all([
    // Qualified leads without an email are what handover exists to fix. Rows
    // already in a batch are included so an open batch still counts.
    sb
      .from("leads")
      .select(
        "id, username, full_name, niche, external_link, profile_url, bio, parent_username, handover_batch_id, handover_enriched_at, email",
      )
      .eq("status", "qualified")
      .is("email", null)
      .is("email_v2", null),
    sb.from("handover_batches").select("id, parent_username").eq("status", "open"),
    sb.from("seeds").select("id, username"),
    getScrapedSeedIds(),
  ]);

  type Row = NonNullable<typeof leads>[number];
  const bySeed = new Map<string, Row[]>();
  for (const lead of leads ?? []) {
    const key = lead.parent_username ?? UNATTRIBUTED;
    const list = bySeed.get(key);
    if (list) list.push(lead);
    else bySeed.set(key, [lead]);
  }

  // Every scraped seed gets a block even with an empty pool — otherwise a
  // scraped account that produced nothing is indistinguishable from one that
  // was never scraped.
  const keys = new Set(bySeed.keys());
  for (const seed of seeds ?? []) if (scrapedIds.has(seed.id)) keys.add(seed.username);

  const openByParent = new Map((batches ?? []).map((batch) => [batch.parent_username, batch.id]));

  return [...keys]
    .map((key) => {
      const rows = bySeed.get(key) ?? [];
      const batchId = openByParent.get(key) ?? null;
      const batchLeads = batchId ? rows.filter((row) => row.handover_batch_id === batchId) : [];

      // Pool = eligible but not yet claimed into a batch — same definition as
      // claimBatch/getPoolCount in lib/handover/batch.ts.
      const pool = rows.filter((row) => !row.handover_batch_id).sort((a, b) => a.username.localeCompare(b.username));

      return {
        parentUsername: key,
        username: key === UNATTRIBUTED ? "Unattributed (imports & manual)" : key,
        total: rows.length,
        done: rows.filter((row) => row.handover_enriched_at).length,
        openBatch: batchId
          ? {
              id: batchId,
              leads: batchLeads.sort((a, b) => a.username.localeCompare(b.username)),
              // Built here so the block's copy button is a plain clipboard
              // write with nothing to fetch or fail at click time.
              copyText: toClipboardText(batchLeads),
            }
          : null,
        poolLeads: pool.slice(0, PREVIEW_LIMIT).map((row) => ({ username: row.username, full_name: row.full_name })),
        poolMore: Math.max(0, pool.length - PREVIEW_LIMIT),
      };
    })
    .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username));
}
