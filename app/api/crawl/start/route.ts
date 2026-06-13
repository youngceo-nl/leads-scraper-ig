import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/inngest/client";
import { getSettings } from "@/lib/config/settings";

const Body = z.object({ seed_id: z.string().uuid() });

export async function POST(req: Request) {
  // Auth: only logged-in users can start crawls
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: seed, error: seedErr } = await admin
    .from("seeds")
    .select("id, username")
    .eq("id", body.seed_id)
    .single();
  if (seedErr || !seed) return NextResponse.json({ error: "seed_not_found" }, { status: 404 });

  const settings = await getSettings(true);

  // Create a crawl_jobs row first so the UI can poll it.
  const { data: job, error: jobErr } = await admin
    .from("crawl_jobs")
    .insert({
      seed_id: seed.id,
      status: "queued",
      max_depth: settings.max_crawl_depth,
    })
    .select("id")
    .single();
  if (jobErr || !job) return NextResponse.json({ error: jobErr?.message ?? "job_create_failed" }, { status: 500 });

  // Send the seed event into Inngest
  const { ids } = await inngest.send({
    name: "crawl/seed.requested",
    data: { crawl_job_id: job.id, seed_id: seed.id, seed_username: seed.username },
  });

  await admin.from("crawl_jobs").update({ inngest_run_id: ids[0] ?? null }).eq("id", job.id);

  return NextResponse.json({ crawl_job_id: job.id, inngest_id: ids[0] ?? null });
}
