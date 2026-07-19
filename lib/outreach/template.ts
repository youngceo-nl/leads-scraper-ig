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
  const firstName = extractFirstName(full) ?? extractFirstNameFromUsername(opts.lead.username) ?? "there";
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

// Try to pull a first name from an Instagram username like "joshlaurentt",
// "josh.lauren", or "josh_lauren". Returns null when no plausible name found.
export function extractFirstNameFromUsername(username: string | null | undefined): string | null {
  if (!username?.trim()) return null;
  const raw = username.trim().toLowerCase();

  // If the username has a separator, the first segment is likely the first name.
  const hasSep = /[._-]/.test(raw);
  const NOT_A_NAME = new Set(["the", "a", "an", "my", "your", "our", "its", "join", "get", "buy", "new", "free", "best", "top", "real", "official"]);
  if (hasSep) {
    const seg = raw.split(/[._-]/)[0] ?? "";
    if (seg.length >= 2 && !/\d/.test(seg) && !NOT_A_NAME.has(seg)) {
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    }
    return null;
  }

  // No separator — try common English first names that appear as a prefix.
  // We match the longest prefix that is a known short name (3–8 chars), so
  // "joshlaurentt" → "josh", "mikefit" → "mike", "sarahjane" → "sarah".
  const COMMON_NAMES = [
    "james","john","robert","michael","william","david","richard","joseph","thomas","charles",
    "christopher","daniel","matthew","anthony","mark","donald","steven","paul","andrew","joshua",
    "kenneth","kevin","brian","george","timothy","ronald","edward","jason","jeffrey","ryan",
    "jacob","gary","nicholas","eric","jonathan","stephen","larry","justin","scott","brandon",
    "benjamin","samuel","raymond","frank","gregory","jack","dennis","jerry","tyler","aaron",
    "mary","patricia","jennifer","linda","barbara","elizabeth","susan","jessica","sarah","karen",
    "lisa","nancy","betty","margaret","sandra","ashley","emily","dorothy","kimberly","carol",
    "michelle","amanda","melissa","deborah","stephanie","rebecca","sharon","laura","cynthia",
    "kathleen","amy","angela","shirley","anna","brenda","pamela","emma","nicole","helen",
    "samantha","katherine","christine","debra","rachel","carolyn","janet","catherine","maria",
    "heather","diane","julie","joyce","victoria","kelly","christina","joan","evelyn","lauren",
    "madison","sophia","olivia","hannah","megan","alexis","brittany","danielle","grace","alex",
    "mike","jake","josh","luke","adam","sean","drew","kyle","ryan","dylan","evan","seth","max",
    "leo","liam","noah","ethan","owen","cole","beau","reed","reid","trey","zach","matt","nick",
    "cody","brad","chad","dane","dean","glen","grant","grey","wade","zane","sara","kate","lily",
    "rose","jade","dawn","hope","joy","june","mia","ava","zoe","ivy","eve","sue","kim","jen",
    "tina","gina","lori","dana","dawn","faye","leah","nina","rita","ruth","vera","amy","ann",
  ];

  for (const name of COMMON_NAMES) {
    if (raw.startsWith(name) && raw.length > name.length) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }

  // Last resort: if the whole username is short enough to be a single name, use it.
  if (raw.length >= 3 && raw.length <= 10 && !/\d/.test(raw)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  return null;
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
  "home", "welcome", "untitled", "get started",
  "link in bio", "my link in bio page", "my link in bio",
]);

// Cleans stored funnel_program_name values that slipped through as page title compounds.
// Applied at render time so existing DB data is fixed without re-enrichment.
function cleanProgramName(name: string | null | undefined): string | null {
  if (!name?.trim()) return null;
  // Strip from pipe onward: "Fortune Consulting | Welcome" → "Fortune Consulting"
  let clean = name.split(/\s*\|\s*/)[0]?.trim() ?? "";
  // Strip trailing marketing suffixes: "Course Name - FULL COURSE" → "Course Name"
  clean = clean.replace(/\s*[-–]\s*(FULL COURSE|FREE TRAINING|LIVE EVENT|WEBINAR|HOSTED BY\b.*)$/i, "").trim();
  if (clean.length < 3 || clean.length > 60) return null;
  // Contains emoji → page title / social bio junk
  if (/\p{Extended_Pictographic}/u.test(clean)) return null;
  // Contains a URL fragment → scraped from a link, not a real name
  if (/\.(com|io|co|net|org|au)\b/i.test(clean)) return null;
  // Matches domain-like pattern (word.word with no spaces) → URL slug
  if (/^\S+\.\S+$/.test(clean)) return null;
  // ALL CAPS multi-word → slogan, not a program name
  if (clean.split(/\s+/).length > 1 && clean === clean.toUpperCase()) return null;
  if (JUNK_PROGRAM_NAMES.has(clean.toLowerCase())) return null;
  if (clean.split(/\s+/).length > 8) return null;
  if (/^(how to |how i |learn how |welcome to |join |here'?s |get your |grab your |claim your |download your |access your |discover |introducing )/i.test(clean)) return null;
  // Lead-magnet descriptors that are page titles, not program names
  if (/\b(e-?book|checklist|cheat sheet|swipe file|pdf|free\s*\d|\d+\s*page)\b/i.test(clean)) return null;
  // Tokens like "FREE100", "BONUS200" — marketing code embedded in a word
  if (/\b[A-Z]{2,}\d+\b/.test(clean)) return null;
  return clean;
}

function buildFallbackProgramName(niche: string | null | undefined): string {
  const raw = niche?.trim();
  if (!raw) return "your coaching program";
  // Strip trailing model words so "fitness coaching" → "fitness" not "fitness coaching coaching program"
  const stripped = raw
    .replace(/\s+(coaching|consulting|training|mentoring|program|programs|course|courses|academy|community)\s*$/i, "")
    .trim();
  const words = (stripped || raw)
    .split(/\s+/)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+(and|or|for|the|a|an|of|in|with)$/i, "")
    .trim();
  return `your ${words} coaching program`;
}

// Converts template body (supports lightweight markdown) to HTML for sending.
// Supported: **bold**, *italic*, - bullet lists, plain line/paragraph breaks.
export function textToHtml(text: string): string {
  // Normalize line endings so \r\n templates split correctly
  const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n{2,}/);
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
