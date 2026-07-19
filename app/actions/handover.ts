"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  claimBatch as claim,
  applyEnrichment as apply,
  closeBatch as close,
  HandoverError,
} from "@/lib/handover/batch";
import { HandoverCsvError } from "@/lib/handover/format";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

export type HandoverResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * HandoverError and HandoverCsvError carry messages written for the operator
 * ("the wrong export was picked"); anything else is a bug and shouldn't have
 * its internals surfaced in the UI.
 */
async function run<T>(fn: () => Promise<T>): Promise<HandoverResult<T>> {
  try {
    const result = await fn();
    revalidatePath("/handover");
    revalidatePath("/leads");
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof HandoverError || error instanceof HandoverCsvError) {
      return { ok: false, error: error.message };
    }
    console.error("[handover]", error);
    return { ok: false, error: "Something went wrong. Check the logs." };
  }
}

export async function claimBatch() {
  await requireUser();
  return run(() => claim());
}

export async function applyEnrichment(csvText: string) {
  await requireUser();
  return run(() => apply(csvText));
}

export async function closeBatch() {
  await requireUser();
  return run(() => close());
}
