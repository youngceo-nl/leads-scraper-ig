"use client";
import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sendOutreachBatchByIds } from "@/app/actions/outreach";

export function SendBatchButton({ leadIds, intervalMinutes }: { leadIds: string[]; intervalMinutes: number; }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const totalHours = ((leadIds.length - 1) * intervalMinutes) / 60;

  const handleSend = () => {
    if (!confirm(
      `Send ${leadIds.length} email${leadIds.length !== 1 ? "s" : ""} at ${intervalMinutes}-minute intervals?\n\nThis will take ~${totalHours.toFixed(1)} hours and cannot be stopped mid-batch.`
    )) return;

    start(async () => {
      const res = await sendOutreachBatchByIds({ leadIds, intervalMinutes });
      if (!res.ok) { setError(res.error ?? "Failed to start batch"); return; }
      setDone(true);
      router.refresh();
    });
  };

  if (done) return <p className="text-sm text-green-700 font-medium">Batch queued — check activity tab for progress.</p>;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handleSend} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
        {pending ? "Queuing…" : `Send ${leadIds.length} emails`}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
