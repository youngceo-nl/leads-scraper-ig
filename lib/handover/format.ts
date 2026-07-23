// Formatting leads out to Clay and parsing enriched rows back in.

/** The downstream enrichment tool works best in batches of this size. */
export const BATCH_SIZE = 15;

export type HandoverLead = {
  id: string;
  username: string;
  full_name: string | null;
  niche: string | null;
  external_link: string | null;
  profile_url: string | null;
  bio: string | null;
};

/**
 * Bare hostname from a bio link — kept for anywhere that still wants a domain
 * out of a lead's bio link (not part of the clipboard export any more).
 */
export function toDomain(link: string | null): string {
  if (!link?.trim()) return "";
  try {
    const url = new URL(link.trim().startsWith("http") ? link.trim() : `https://${link.trim()}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type ClipboardLead = { full_name: string | null; profile_url: string | null; bio: string | null };

// bad_lead_reason is always blank going out — it's a slot for the operator to
// type into while working the batch in Clay, not something we can prefill.
// A filled cell coming back means "this lead is bad, here's why" (see
// parseEnrichedCsv/EnrichedRow.badReason); empty means the lead is good.
const EXPORT_COLUMNS = ["profile_url", "full_name", "bio", "bad_lead_reason"] as const;

function toRow(lead: ClipboardLead): string[] {
  return [lead.profile_url ?? "", lead.full_name ?? "", lead.bio ?? "", ""];
}

/**
 * Tab-separated, because that is what pasting into a Clay table (or any
 * spreadsheet) expects. Tabs and newlines inside a value (bios especially)
 * would break the row apart, so they collapse to spaces rather than being
 * quoted — quoting is a CSV convention that clipboard paste does not honour.
 *
 * No bare username column — `profile_url` is what carries identity forward
 * for the round trip instead (see `parseEnrichedCsv`, which extracts the
 * handle back out of it), since the operator only wants url/name/bio visible.
 */
export function toClipboardText(leads: ClipboardLead[]): string {
  const clean = (value: string) => value.replace(/[\t\r\n]+/g, " ").trim();
  return [
    EXPORT_COLUMNS.join("\t"),
    ...leads.map((lead) => toRow(lead).map(clean).join("\t")),
  ].join("\n");
}

// ─── Enriched CSV back in ────────────────────────────────────────────────────

export type CsvRow = Record<string, string>;

export class HandoverCsvError extends Error {}

/**
 * Minimal RFC4180 tokenizer — handles quoted fields containing commas,
 * newlines and escaped quotes, which Clay exports do produce (bios, company
 * names). Returns raw rows, header row included as the first — callers that
 * only need the header (a preview, before any data rows are guaranteed to
 * exist) can stop after `rows[0]`.
 */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (quoted) {
      if (char === '"') {
        // Doubled quote inside a quoted field is a literal quote.
        if (normalized[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  return rows;
}

function parseCsv(text: string): CsvRow[] {
  const rows = tokenizeCsv(text);
  const headers = rows.shift()?.map((h) => h.trim()) ?? [];
  if (!headers.length) throw new HandoverCsvError("The CSV has no header row.");

  return rows
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])));
}

/** The CSV's column names, for previewing before committing to an import. */
export function getCsvHeaders(text: string): string[] {
  const headers = tokenizeCsv(text.trim())[0]?.map((h) => h.trim()) ?? [];
  if (!headers.length) throw new HandoverCsvError("The CSV has no header row.");
  return headers;
}

/** Case/spacing/separator differences shouldn't matter — "Work Email" ≡ "work_email". */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Case- and separator-insensitive lookup, so "Work Email" matches "work_email". */
function pick(row: CsvRow, candidates: string[]): string | null {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const candidate of candidates) {
    const value = normalized.get(normalizeKey(candidate));
    if (value?.trim()) return value.trim();
  }
  return null;
}

/** Same matching as `pick`, but against bare headers — returns which header matched, not a row's value. */
function pickHeader(headers: string[], candidates: string[]): string | null {
  const normalized = new Map(headers.map((h) => [normalizeKey(h), h]));
  for (const candidate of candidates) {
    const match = normalized.get(normalizeKey(candidate));
    if (match) return match;
  }
  return null;
}

export type EnrichedRow = { username: string; email: string | null; badReason: string | null };

const BAD_REASON_COLUMNS = ["bad_lead_reason", "bad reason", "bad_reason"];

const USERNAME_COLUMNS = [
  "username", "handle", "instagram", "ig", "ig_handle", "instagram_handle",
  // The export no longer includes a bare username column — profile_url is the
  // identifying column that survives the round trip, so it has to be a
  // candidate too. Tried after the handle-shaped ones since those are
  // unambiguous; a URL still needs IG_PROFILE_RE to pull the handle out of it.
  "profile_url", "instagram_url", "ig_url",
];

const EMAIL_COLUMNS = [
  "email", "workEmail", "work_email", "emailAddress", "professionalEmail",
  // "Personal Email" is what this Clay table template actually names the
  // column — without it, every found email in a batch exported from that
  // template silently disappears (row still imports, just with no email,
  // indistinguishable from "Clay found nothing").
  "personalEmail", "personal_email",
];

/**
 * What `parseEnrichedCsv` could confidently match from a CSV's own header
 * names, for a preview before committing to an import.
 */
export type DetectedColumns = { username: string | null; email: string | null; badReason: string | null };

export function detectColumns(headers: string[]): DetectedColumns {
  return {
    username: pickHeader(headers, USERNAME_COLUMNS),
    email: pickHeader(headers, EMAIL_COLUMNS),
    badReason: pickHeader(headers, BAD_REASON_COLUMNS),
  };
}

/**
 * Operator-confirmed column choices, from the mapping dialog. `username` is
 * always a real header (required to proceed); `email`/`badReason` are `null`
 * for an explicit "no such column in this file" rather than "not decided" —
 * once a mapping exists at all, nothing in `parseEnrichedCsv` falls back to
 * guessing, so a confirmed "no email column" can't be silently overridden by
 * a coincidental candidate match elsewhere in the sheet.
 */
export type ColumnMapping = { username: string; email: string | null; badReason: string | null };

/**
 * `@handle` or a full profile URL both reduce to the bare handle — mirrors
 * `resolveUsername` in app/actions/leads.ts, since Clay may echo back either
 * shape depending on how the sheet was set up.
 */
const IG_PROFILE_RE = /instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?/;
function normalizeUsername(raw: string): string | null {
  const direct = raw.trim().replace(/^@/, "").toLowerCase();
  if (direct && /^[a-z0-9._]{1,30}$/.test(direct)) return direct;
  const fromUrl = raw.match(IG_PROFILE_RE)?.[1]?.toLowerCase();
  return fromUrl ?? null;
}

/**
 * Parses a returned Clay export. Rows without an email are kept rather than
 * dropped: they are how we learn Clay found nothing for that lead, which is a
 * result worth recording so the lead doesn't cycle back into the pool forever.
 *
 * Matched back to leads by username (unique in the leads table) rather than a
 * hidden id column. The clipboard export carries no bare username column —
 * only `profile_url` — so the handle is pulled back out of that URL
 * (`normalizeUsername`) unless a username/handle-shaped column happens to
 * come back too.
 *
 * Without `mapping`, columns are guessed from the known candidate lists —
 * today's behavior, for a CSV that already has recognizable headers. With
 * `mapping` (the operator confirmed it via the column-mapping dialog after a
 * guess came back ambiguous), that guessing is bypassed entirely: each field
 * uses exactly the header the operator picked, or is forced to `null` if they
 * confirmed no such column exists.
 */
export function parseEnrichedCsv(text: string, mapping?: ColumnMapping): EnrichedRow[] {
  const rows = parseCsv(text.trim());
  if (!rows.length) throw new HandoverCsvError("The CSV has no data rows.");

  const usernameCandidates = mapping ? [mapping.username] : USERNAME_COLUMNS;
  if (!rows.some((row) => pick(row, usernameCandidates))) {
    throw new HandoverCsvError(
      mapping
        ? `The CSV has no "${mapping.username}" column.`
        : 'The CSV has no "profile_url" (or username/handle) column. It is the only way rows can be matched back to leads.',
    );
  }

  const emailCandidates = mapping ? (mapping.email ? [mapping.email] : []) : EMAIL_COLUMNS;
  const badReasonCandidates = mapping ? (mapping.badReason ? [mapping.badReason] : []) : BAD_REASON_COLUMNS;

  return rows.map((row, index) => {
    const raw = pick(row, usernameCandidates);
    const username = raw ? normalizeUsername(raw) : null;
    if (!username) throw new HandoverCsvError(`Row ${index + 2} has an empty or invalid username.`);
    return {
      username,
      email: pick(row, emailCandidates),
      badReason: pick(row, badReasonCandidates),
    };
  });
}
