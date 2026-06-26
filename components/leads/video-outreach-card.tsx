"use client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Video, RefreshCw, AlertCircle, ExternalLink } from "lucide-react";
import { requestOutreachVideo, retryVideoJob } from "@/app/actions/video";
import { createClient } from "@/lib/supabase/client";
import type { VideoJob } from "@/lib/types";

const TERMINAL_STATUSES = new Set(["done", "failed"]);

const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  generating_script: "Writing hook script",
  generating_audio: "Generating voice",
  recording_profile: "Capturing prospect site",
  rendering_video: "Rendering video",
  uploading_to_loom: "Uploading to Loom",
  done: "Done",
  failed: "Failed",
};

export function VideoOutreachCard({ leadId, initialJob }: { leadId: string; initialJob: VideoJob | null }) {
  const [job, setJob] = useState(initialJob);
  const [requesting, setRequesting] = useState(false);

  // No realtime subscriptions elsewhere in this app — plain polling while a
  // job is in flight matches the codebase's existing patterns.
  useEffect(() => {
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    const sb = createClient();
    const interval = setInterval(async () => {
      const { data } = await sb.from("video_jobs").select("*").eq("id", job.id).single();
      if (data) setJob(data as VideoJob);
    }, 4000);
    return () => clearInterval(interval);
  }, [job]);

  const onGenerate = async () => {
    setRequesting(true);
    const r = await requestOutreachVideo(leadId);
    setRequesting(false);
    if (r.ok && r.jobId) {
      setJob({
        id: r.jobId,
        lead_id: leadId,
        status: "pending",
        hook_script: null,
        loom_url: null,
        loom_embed_code: null,
        error_message: null,
        attempt_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  };

  const onRetry = async () => {
    if (!job) return;
    setRequesting(true);
    await retryVideoJob(job.id);
    setRequesting(false);
    setJob({ ...job, status: "pending", error_message: null });
  };

  if (!job) {
    return (
      <Card>
        <CardHeader><CardTitle>Outreach video</CardTitle></CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={onGenerate} disabled={requesting}>
            {requesting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Video className="h-3 w-3 mr-1" />}
            Generate video
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isActive = !TERMINAL_STATUSES.has(job.status);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Outreach video</CardTitle>
        <Badge variant={job.status === "done" ? "default" : job.status === "failed" ? "destructive" : "secondary"}>
          {isActive && <Loader2 className="h-3 w-3 mr-1 animate-spin inline" />}
          {STATUS_LABELS[job.status] ?? job.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {job.hook_script && <p className="text-muted-foreground italic">&quot;{job.hook_script}&quot;</p>}

        {job.status === "done" && job.loom_url && (
          <div className="space-y-2">
            <a
              href={job.loom_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> {job.loom_url}
            </a>
            <div>
              <Button variant="outline" size="sm" onClick={onGenerate} disabled={requesting}>
                {requesting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Generate another
              </Button>
            </div>
          </div>
        )}

        {job.status === "failed" && (
          <div className="space-y-2">
            <p className="flex items-center gap-1 text-red-600">
              <AlertCircle className="h-3 w-3" /> {job.error_message ?? "Something went wrong."}
            </p>
            <Button variant="outline" size="sm" onClick={onRetry} disabled={requesting}>
              {requesting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Retry
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
