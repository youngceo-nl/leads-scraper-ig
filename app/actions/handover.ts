"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  claimBatch as claim,
  applyEnrichmentAll as applyAll,
  closeBatch as close,
  getDispatchState as dispatchState,
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

export async function claimBatch(parentUsername: string) {
  await requireUser();
  return run(() => claim(parentUsername));
}

/** Applies one returned Clay CSV across every open batch at once — see applyEnrichmentAll. */
export async function applyEnrichmentGlobal(csvText: string) {
  await requireUser();
  return run(() => applyAll(csvText));
}

export async function closeBatch(parentUsername: string) {
  await requireUser();
  return run(() => close(parentUsername));
}

/** Drives the whole-page dispatch lock — no revalidatePath, this is a plain read polled from the client. */
export async function getDispatchState() {
  await requireUser();
  return dispatchState();
}
