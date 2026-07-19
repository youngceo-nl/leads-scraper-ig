// Formatting leads out to Clay and parsing enriched rows back in.

/** Ties an exported row back to its lead on re-import. */
export const LEAD_ID_COLUMN = "lead_id";

/** The downstream enrichment tool works best in batches of this size. */
export const BATCH_SIZE = 15;

export type HandoverLead = {
  id: string;
  username: string;
  full_name: string | null;
  niche: string | null;
  external_link: string | null;
  profile_url: string | null;
};

/**
 * Columns handed to Clay. `lead_id` comes first and must survive the round
 * trip — matching on username instead would misfire the moment Clay rewrites
 * or drops that column, and matching on email is impossible when finding the
 * email is the whole point.
 */
const EXPORT_COLUMNS = [
  LEAD_ID_COLUMN,
  "username",
  "full_name",
  "domain",
  "niche",
  "profile_url",
] as const;

/**
 * Bare hostname from a bio link — Clay's email waterfall keys off domain plus
 * full name, and it wants `acme.com`, not `https://acme.com/checkout?ref=ig`.
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

function toRow(lead: HandoverLead): string[] {
  return [
    lead.id,
    lead.username ?? "",
    lead.full_name ?? "",
    toDomain(lead.external_link),
    lead.niche ?? "",
    lead.profile_url ?? "",
  ];
}

/**
 * Tab-separated, because that is what pasting into a Clay table (or any
 * spreadsheet) expects. Tabs and newlines inside a value would break the row
 * apart, so they collapse to spaces rather than being quoted — quoting is a
 * CSV convention that clipboard paste does not honour.
 */
export function toClipboardTsv(leads: HandoverLead[]): string {
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

export type EnrichedRow = { leadId: string; email: string | null };

/**
 * Parses a returned Clay export. Rows without an email are kept rather than
 * dropped: they are how we learn Clay found nothing for that lead, which is a
 * result worth recording so the lead doesn't cycle back into the pool forever.
 */
export function parseEnrichedCsv(text: string): EnrichedRow[] {
  const rows = parseCsv(text.trim());
  if (!rows.length) throw new HandoverCsvError("The CSV has no data rows.");

  if (!rows.some((row) => pick(row, [LEAD_ID_COLUMN]))) {
    throw new HandoverCsvError(
      `The CSV has no "${LEAD_ID_COLUMN}" column. Export from Clay with that column intact — ` +
        "it is the only way rows can be matched back to leads.",
    );
  }

  return rows.map((row, index) => {
    const leadId = pick(row, [LEAD_ID_COLUMN]);
    if (!leadId) throw new HandoverCsvError(`Row ${index + 2} has an empty "${LEAD_ID_COLUMN}".`);
    return {
      leadId,
      email: pick(row, ["email", "workEmail", "work_email", "emailAddress", "professionalEmail"]),
    };
  });
}
