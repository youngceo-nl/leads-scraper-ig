import { createAdminClient } from "@/lib/supabase/admin";
import { LogsLive } from "@/components/logs/logs-live";
import { PipelineStats } from "@/components/logs/pipeline-stats";
import { LiveOperationCard } from "@/components/logs/live-operation-card";
import { FollowupBatchCard } from "@/components/outreach/followup-batch-card";
import { getPipelineStats } from "@/app/actions/leads";
import { getFollowupBatchProgress } from "@/app/actions/outreach";
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  const sb = createAdminClient();
  const [{ data: crawl }, { data: errors }, stats, followupProgress] = await Promise.all([
    sb.from("crawl_logs").select("*").order("created_at", { ascending: false }).limit(200),
    sb.from("error_logs").select("*").order("created_at", { ascending: false }).limit(100),
    getPipelineStats(),
    getFollowupBatchProgress(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">Pipeline state, errors, and a live feed of everything running.</p>
      </div>

      <LiveOperationCard />

      <FollowupBatchCard initial={followupProgress} />

      <PipelineStats stats={stats} />

      <Separator />

      <LogsLive initialCrawl={crawl ?? []} initialErrors={errors ?? []} />
    </div>
  );
}
