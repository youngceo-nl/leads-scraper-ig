import { getOpenBatch, getPoolCount } from "@/lib/handover/batch";
import { toClipboardTsv } from "@/lib/handover/format";
import { HandoverClient } from "@/components/handover/handover-client";

export const dynamic = "force-dynamic";

export default async function HandoverPage() {
  const [batch, poolCount] = await Promise.all([getOpenBatch(), getPoolCount()]);

  return (
    <HandoverClient
      poolCount={poolCount}
      batch={
        batch && {
          id: batch.id,
          createdAt: batch.created_at,
          leads: batch.leads,
          enrichedCount: batch.enrichedCount,
          // Built server-side so the copy button is a plain clipboard write
          // with nothing to fetch or fail at click time.
          tsv: toClipboardTsv(batch.leads),
        }
      }
    />
  );
}
