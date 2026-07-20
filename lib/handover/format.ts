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

const EXPORT_COLUMNS = ["profile_url", "full_name", "bio"] as const;

function toRow(lead: ClipboardLead): string[] {
  return [lead.profile_url ?? "", lead.full_name ?? "", lead.bio ?? ""];
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
 * Minimal RFC4180 parser — handles quoted fields containing commas, newlines
 * and escaped quotes, which Clay exports do produce (bios, company names).
 */
function parseCsv(text: string): CsvRow[] {
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

  const headers = rows.shift()?.map((h) => h.trim()) ?? [];
  if (!headers.length) throw new HandoverCsvError("The CSV has no header row.");

  return rows
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])));
}

/** Case- and separator-insensitive lookup, so "Work Email" matches "work_email". */
function pick(row: CsvRow, candidates: string[]): string | null {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[\s_-]+/g, ""), value]),
  );
  for (const candidate of candidates) {
    const value = normalized.get(candidate.toLowerCase().replace(/[\s_-]+/g, ""));
    if (value?.trim()) return value.trim();
  }
  return null;
}

export type EnrichedRow = { username: string; email: string | null };

const USERNAME_COLUMNS = [
  "username", "handle", "instagram", "ig", "ig_handle", "instagram_handle",
  // The export no longer includes a bare username column — profile_url is the
  // identifying column that survives the round trip, so it has to be a
  // candidate too. Tried after the handle-shaped ones since those are
  // unambiguous; a URL still needs IG_PROFILE_RE to pull the handle out of it.
  "profile_url", "instagram_url", "ig_url",
];

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
 */
export function parseEnrichedCsv(text: string): EnrichedRow[] {
  const rows = parseCsv(text.trim());
  if (!rows.length) throw new HandoverCsvError("The CSV has no data rows.");

  if (!rows.some((row) => pick(row, USERNAME_COLUMNS))) {
    throw new HandoverCsvError(
      'The CSV has no "profile_url" (or username/handle) column. It is the only way rows can be matched back to leads.',
    );
  }

  return rows.map((row, index) => {
    const raw = pick(row, USERNAME_COLUMNS);
    const username = raw ? normalizeUsername(raw) : null;
    if (!username) throw new HandoverCsvError(`Row ${index + 2} has an empty or invalid username.`);
    return {
      username,
      email: pick(row, ["email", "workEmail", "work_email", "emailAddress", "professionalEmail"]),
    };
  });
}
