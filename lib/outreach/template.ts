import type { Lead } from "@/lib/types";

// Mustache-lite substitution. Supports:
//   {{program_name}}  — double braces
//   {program name}    — single braces, spaces normalized to underscores
//   {{name|fallback}} — optional fallback value
export type TemplateContext = Record<string, string | number | null | undefined>;

// Matches {{key|fallback}} or {key} (single or double braces, spaces/hyphens in key allowed)
const TOKEN = /\{\{?\s*([a-zA-Z0-9_ -]+?)(?:\s*\|\s*([^}]*?))?\s*\}?\}/g;

export function renderTemplate(tpl: string, ctx: TemplateContext): string {
  return tpl.replace(TOKEN, (_match, rawKey: string, fallback?: string) => {
    // Normalize spaces and hyphens → underscores so "{first-name}" and "{program name}" both work
    const key = rawKey.trim().replace(/[\s-]+/g, "_");
    const v = ctx[key];
    if (v == null || v === "") return (fallback ?? "").trim();
    return String(v);
  });
}

export function buildLeadContext(opts: {
  lead: Pick<
    Lead,
    | "username"
    | "full_name"
    | "niche"
    | "business_model"
    | "funnel_program_name"
    | "funnel_offer_summary"
    | "external_link"
  >;
  senderName: string | null;
}): TemplateContext {
  const full = (opts.lead.full_name ?? "").trim();
  const firstName = extractFirstName(full) ?? "";
  return {
    first_name: firstName,
    name: firstName,
    full_name: full || opts.lead.username,
    username: opts.lead.username,
    niche: opts.lead.niche ?? "",
    business_model: opts.lead.business_model ?? "",
    program_name: cleanProgramName(opts.lead.funnel_program_name) || buildFallbackProgramName(opts.lead.niche),
    offer_summary: opts.lead.funnel_offer_summary ?? "",
    external_link: opts.lead.external_link ?? "",
    sender_name: opts.senderName ?? "",
  };
}

// Returns null when no clean first name can be extracted — callers should
// treat null as a hard block on sending rather than substituting the username.
export function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName?.trim()) return null;

  // Strip everything from the first separator character onward.
  // These mark title/role suffixes: "Josh Klein | Coach", "Ryan • Fitness"
  const beforeSeparator = fullName.split(/[|•·—–:@/\\]/)[0] ?? "";

  // Dots are word separators in username-style names ("ryan.doe" → "ryan doe")
  // but we want to reject them as names, so replace with space before cleaning.
  const withSpaces = beforeSeparator.replace(/\./g, " ");

  // Check for digits on the raw first token BEFORE stripping — rejects "joshsklein23"
  // even after digits would otherwise be cleaned out.
  const rawFirstToken = withSpaces.trim().split(/\s+/)[0] ?? "";
  if (/\d/.test(rawFirstToken)) return null;

  // Remove emojis and non-letter symbols. Keep letters (any script),
  // spaces, hyphens (Marie-Claire), and apostrophes (O'Brien).
  const cleaned = withSpaces
    .replace(/\p{Emoji_Presentation}/gu, "")
    .replace(/[^\p{L}\p{M}'\- ]/gu, "")
    .trim();

  if (!cleaned) return null;

  // Take the first word only — last names and middle names aren't the first name.
  const firstWord = cleaned.split(/\s+/)[0];
  if (!firstWord) return null;

  // Must be at least 2 letters.
  const lettersOnly = firstWord.replace(/[^a-zA-Z]/g, "");
  if (lettersOnly.length < 2) return null;

  // Reject common non-name words that can appear as the first token
  const NOT_A_NAME = new Set(["the", "a", "an", "my", "your", "our", "its", "join", "get", "buy", "new", "free", "best", "top", "real", "official"]);
  if (NOT_A_NAME.has(lettersOnly.toLowerCase())) return null;

  // Title-case: handles all-caps ("MIKE" → "Mike") and already-cased ("Josh" → "Josh").
  // Only flatten if entirely uppercase — mixed-case names like "McGregor" stay intact.
  const isAllCaps = firstWord === firstWord.toUpperCase();
  return isAllCaps
    ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase()
    : firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
}

const JUNK_PROGRAM_NAMES = new Set([
  "opt in", "opt-in", "optin", "free training", "free masterclass",
  "register", "register now", "sign up", "sign up now",
  "watch now", "watch video", "free video", "instant access",
  "apply now", "book a call", "schedule a call", "get access",
  "home", "welcome", "untitled",
]);

// Cleans stored funnel_program_name values that slipped through as page title compounds.
// Applied at render time so existing DB data is fixed without re-enrichment.
function cleanProgramName(name: string | null | undefined): string | null {
  if (!name?.trim()) return null;
  // Strip from pipe onward: "Fortune Consulting | Welcome" → "Fortune Consulting"
  let clean = name.split(/\s*\|\s*/)[0]?.trim() ?? "";
  // Strip trailing marketing suffixes: "Course Name - FULL COURSE" → "Course Name"
  clean = clean.replace(/\s*[-–]\s*(FULL COURSE|FREE TRAINING|LIVE EVENT|WEBINAR|HOSTED BY\b.*)$/i, "").trim();
  if (clean.length < 3 || clean.length > 50) return null;
  if (JUNK_PROGRAM_NAMES.has(clean.toLowerCase())) return null;
  if (clean.split(/\s+/).length > 5) return null;
  if (/^(how to |how i |learn how |welcome to |join )/i.test(clean)) return null;
  return clean;
}

function buildFallbackProgramName(niche: string | null | undefined): string {
  const topic = niche?.toLowerCase().trim();
  if (!topic) return "your coaching program";
  const words = topic.split(/\s+/).slice(0, 2).join(" ");
  return `your ${words} coaching program`;
}

// Converts template body (supports lightweight markdown) to HTML for sending.
// Supported: **bold**, *italic*, - bullet lists, plain line/paragraph breaks.
export function textToHtml(text: string): string {
  // Split into blocks on blank lines
  const blocks = text.split(/\n{2,}/);
  const rendered = blocks.map((block) => {
    const lines = block.split("\n");
    // Bullet list block: all lines start with "- " or "* "
    if (lines.every((l) => /^[-*]\s/.test(l.trimStart()))) {
      const items = lines.map((l) => {
        const content = l.replace(/^[-*]\s/, "").trim();
        return `<li>${inlineMarkdown(htmlEsc(content))}</li>`;
      });
      return `<ul style="margin:0 0 0 1.2em;padding:0">${items.join("")}</ul>`;
    }
    // Normal paragraph
    const inner = lines
      .map((l) => inlineMarkdown(htmlEsc(l)))
      .join("<br />");
    return `<p style="margin:0 0 1em 0">${inner}</p>`;
  });
  return rendered.join("\n");
}

function htmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}
