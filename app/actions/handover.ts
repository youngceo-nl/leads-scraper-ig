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
import { detectColumns, getCsvHeaders, HandoverCsvError, type ColumnMapping } from "@/lib/handover/format";
import { getAccountHandoverStats } from "@/lib/handover/overview";

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

/**
 * Reads a returned Clay CSV's headers before anything is imported, so the
 * client can tell whether the identifying/email columns were recognized —
 * and if not, ask the operator which header is which instead of silently
 * treating an unrecognized email column as "Clay found nothing" (see
 * lib/handover/format.ts's ColumnMapping doc).
 */
export async function previewHandoverCsv(csvText: string) {
  await requireUser();
  return run(async () => {
    const headers = getCsvHeaders(csvText);
    return { headers, detected: detectColumns(headers) };
  });
}

/** Applies one returned Clay CSV across every open batch at once — see applyEnrichmentAll. */
export async function applyEnrichmentGlobal(csvText: string, mapping?: ColumnMapping) {
  const user = await requireUser();
  return run(() => applyAll(csvText, user.id, mapping));
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

/**
 * Drives HandoverSection's live refresh — no revalidatePath, this is a plain
 * read polled from the client (same shape as getDispatchState above).
 * Without this the section only ever showed whatever was true at the last
 * full page load, which reads as "stuck" during an active backfill/scoring
 * run even though the real numbers are changing underneath every minute.
 */
export async function getHandoverAccounts() {
  await requireUser();
  return getAccountHandoverStats();
}
