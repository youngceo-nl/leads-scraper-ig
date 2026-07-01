import { Mail } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { FollowupPreviewList } from "@/components/outreach/followup-preview-list";
import { getFollowupQueue } from "@/app/actions/outreach";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export const dynamic = "force-dynamic";

const INTERVAL_MINUTES = 20;

export default async function FollowupPage() {
  const leads = await getFollowupQueue();

  return (
    <div className="p-6 max-w-4xl">
      <Link
        href="/outreach"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Outreach
      </Link>

      {leads.length === 0 ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight mb-6">Follow-up queue</h1>
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              <Mail className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No leads ready for follow-up</p>
              <p className="text-sm mt-1">Leads need at least one sent outreach, no bounce, and no prior follow-up.</p>
            </CardContent>
          </Card>
        </>
      ) : (
        <FollowupPreviewList leads={leads} intervalMinutes={INTERVAL_MINUTES} />
      )}
    </div>
  );
}
