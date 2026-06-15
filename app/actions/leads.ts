"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";
import { processLead } from "@/app/actions/process-lead";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

export type AddLeadResult = {
  ok: boolean;
  error?: string;
  username?: string;
  already_existed?: boolean;
  analyzing?: boolean;
};

// Add a single lead by hand from the Leads page. We only need a username; the
// rest of the profile is filled in by the normal analyze pipeline. When
// `analyze` is on (the default) we kick that pipeline off immediately so a bare
// username turns into a scored lead without a second click.
export async function addLead(formData: FormData): Promise<AddLeadResult> {
  await requireUser();

  const raw = String(formData.get("input") ?? "").trim();
  if (!raw) return { ok: false, error: "Enter an Instagram username or profile URL." };

  const username = toUsername(raw);
  if (!username || !/^[a-z0-9._]{1,30}$/.test(username)) {
    return { ok: false, error: "That doesn't look like a valid Instagram username." };
  }

  const analyze = formData.get("analyze") === "on";
  const sb = createAdminClient();

  const { data: inserted, error } = await sb
    .from("leads")
    .insert({ username, profile_url: profileUrl(username), status: "pending", crawl_depth: 0 })
    .select("id")
    .single();

  if (error) {
    if (!/duplicate|unique/i.test(error.message)) return { ok: false, error: error.message };
    revalidatePath("/leads");
    return { ok: true, username, already_existed: true };
  }

  if (analyze && inserted?.id) {
    const res = await processLead(inserted.id as string);
    if (!res.ok) {
      // The lead is saved; only the analysis couldn't start. Don't fail the add.
      revalidatePath("/leads");
      return { ok: true, username, analyzing: false, error: `Added, but analysis couldn't start: ${res.error}` };
    }
  }

  revalidatePath("/leads");
  return { ok: true, username, analyzing: analyze };
}

export type DeleteLeadsResult = { ok: boolean; deleted: number; error?: string };

// Bulk-delete leads by id. Before deleting, each lead's username is recorded in
// `excluded_usernames` so the crawler never re-adds it as a fresh duplicate.
export async function deleteLeads(ids: string[]): Promise<DeleteLeadsResult> {
  const user = await requireUser();
  const clean = [...new Set((ids ?? []).filter((id) => typeof id === "string" && id.length > 0))];
  if (clean.length === 0) return { ok: true, deleted: 0 };

  const sb = createAdminClient();

  // 1. Look up usernames so we can remember them on the exclusion list.
  const { data: rows, error: selErr } = await sb
    .from("leads")
    .select("id, username")
    .in("id", clean);
  if (selErr) return { ok: false, deleted: 0, error: selErr.message };

  const usernames = (rows ?? [])
    .map((r) => r.username)
    .filter((u): u is string => !!u);

  // 2. Record them as excluded (idempotent — ignore ones already listed).
  if (usernames.length) {
    const excludeRows = usernames.map((u) => ({
      username: u.toLowerCase(),
      reason: "bulk_delete",
      excluded_by: user.id,
    }));
    const { error: exErr } = await sb
      .from("excluded_usernames")
      .upsert(excludeRows, { onConflict: "username", ignoreDuplicates: true });
    if (exErr) return { ok: false, deleted: 0, error: exErr.message };
  }

  // 3. Delete the leads (lead_notes + outreach_messages cascade on FK).
  const { error: delErr, count } = await sb
    .from("leads")
    .delete({ count: "exact" })
    .in("id", clean);
  if (delErr) return { ok: false, deleted: 0, error: delErr.message };

  revalidatePath("/leads");
  return { ok: true, deleted: count ?? clean.length };
}
