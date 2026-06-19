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
  const firstName = full ? full.split(/\s+/)[0] : opts.lead.username;
  return {
    first_name: firstName,
    name: firstName,          // alias: {name} → first name
    full_name: full || opts.lead.username,
    username: opts.lead.username,
    niche: opts.lead.niche ?? "",
    business_model: opts.lead.business_model ?? "",
    program_name: opts.lead.funnel_program_name ?? "",
    offer_summary: opts.lead.funnel_offer_summary ?? "",
    external_link: opts.lead.external_link ?? "",
    sender_name: opts.senderName ?? "",
  };
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
