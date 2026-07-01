// Build a PostgREST `.or(...)` filter from a comma-separated keyword string.
// Terms are matched ilike "%term%" against username, full_name, bio, niche, email.
// Returns null when there are no usable terms.
const FIELDS = ["username", "full_name", "bio", "niche", "email", "email_v2"] as const;

export function parseKeywords(q: string | undefined | null): string[] {
  if (!q) return [];
  return q
    .split(",")
    .map((t) => t.trim().replace(/[,()"\\]/g, ""))
    .filter(Boolean);
}

export function buildKeywordOr(q: string | undefined | null): string | null {
  const terms = parseKeywords(q);
  if (terms.length === 0) return null;
  return terms.flatMap((t) => FIELDS.map((f) => `${f}.ilike.%${t}%`)).join(",");
}
