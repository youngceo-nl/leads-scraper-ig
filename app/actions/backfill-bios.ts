"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { inngest } from "@/inngest/client";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

// Hard cap on how many leads one click will queue, to keep the burner cookie
// (which fetches ~1 profile/sec) from being asked to do an unbounded amount of
// work in a single backfill run.
const MAX_PER_RUN = 1000;
// Usernames per backfill event. backfill-metadata batches further internally.
const CHUNK = 250;

export type BioCoverage = {
  total: number;
  withBio: number;
  missing: number;
};

// Counts for the coverage card: how many leads have a stored bio vs. not.
export async function getBioCoverage(): Promise<BioCoverage> {
  const sb = createAdminClient();
  const [{ count: total }, { count: withBio }] = await Promise.all([
    sb.from("leads").select("*", { count: "exact", head: true }),
    sb.from("leads").select("*", { count: "exact", head: true }).not("bio", "is", null),
  ]);
  const t = total ?? 0;
  const w = withBio ?? 0;
  return { total: t, withBio: w, missing: Math.max(0, t - w) };
}

// Queue a metadata backfill for every lead that has no stored bio yet. This is
// the recovery path for gaps the automatic post-search backfill can leave
// behind — e.g. leads discovered before the cookie was set, or accounts skipped
// when an expired cookie halted an earlier batch. Safe to run repeatedly: the
// backfill update is idempotent and prefers the free cookie path.
export async function backfillMissingBios(): Promise<
  { ok: true; queued: number; capped: boolean } | { ok: false; error: string }
> {
  await requireUser();
  const sb = createAdminClient();

  const { data, error } = await sb
    .from("leads")
    .select("username")
    .is("bio", null)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return { ok: false, error: error.message };

  const usernames = (data ?? []).map((r) => r.username).filter(Boolean) as string[];
  if (usernames.length === 0) return { ok: true, queued: 0, capped: false };

  const events = [];
  for (let i = 0; i < usernames.length; i += CHUNK) {
    events.push({
      name: "leads/backfill.metadata.requested" as const,
      data: { usernames: usernames.slice(i, i + CHUNK), crawl_job_id: null },
    });
  }
  await inngest.send(events);

  revalidatePath("/seeds");
  return { ok: true, queued: usernames.length, capped: usernames.length >= MAX_PER_RUN };
}
