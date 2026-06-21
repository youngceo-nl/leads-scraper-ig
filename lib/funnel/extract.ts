import "server-only";
import * as cheerio from "cheerio";

export type FunnelExtraction = {
  program_name: string | null;
  offer_summary: string | null;
  price: string | null;
  raw_text_for_llm: string;
  good_enough: boolean;
};

const BAD_TITLES = new Set([
  "", "home", "welcome", "untitled", "sign in", "log in", "login",
  "page not found", "404", "loading...", "loading",
  // Opt-in / funnel page titles that tell us nothing about the program
  "opt in", "opt-in", "optin", "free training", "free masterclass",
  "register", "register now", "sign up", "sign up now",
  "watch now", "watch video", "free video", "instant access",
  "apply now", "book a call", "schedule a call", "get access",
]);

// Returns true if the string is clearly NOT a program/offer name.
function isJunk(s: string): boolean {
  // Social aggregator titles: "@handle | Instagram, YouTube..."
  if (/^\s*@/.test(s)) return true;
  // Any pipe separator means this is a compound page title, not a clean program name
  // e.g. "Fortune Consulting | Welcome", "Calls Into Listings | Live Event | Hosted by..."
  if (/\s\|\s/.test(s)) return true;
  // Discord / community invites
  if (/^join\s+/i.test(s)) return true;
  if (/\bdiscord\b.*\b(server|community|invite)\b/i.test(s)) return true;
  // All-lowercase no-space strings — usernames masquerading as names
  if (/^[a-z][a-z0-9]{2,}$/.test(s)) return true;
  // Marketing copy embedded in video/product titles
  if (/\b(FULL COURSE|FREE TRAINING|LIVE EVENT|HOSTED BY|WEBINAR|REGISTER NOW|SIGN UP NOW)\b/i.test(s)) return true;
  // Anything over 50 chars is a page title / sentence fragment, not a program name
  if (s.length > 50) return true;
  // More than 5 words → sentence/headline, not a program name
  // Real program names are 2–4 words: "High Ticket Closer", "Freedom Architect"
  if (s.split(/\s+/).length > 5) return true;
  // Sentence-style CTA / blog-post starters that are never real program names
  if (/^(how to |how i |learn how |welcome to )/i.test(s)) return true;
  return false;
}

export function extractFunnel(opts: { html: string; platform: string }): FunnelExtraction {
  const $ = cheerio.load(opts.html);
  const ogTitle = $('meta[property="og:title"], meta[name="og:title"]').attr("content")?.trim() || null;
  const ogDesc = $('meta[property="og:description"], meta[name="og:description"]').attr("content")?.trim() || null;
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() || null;
  const docTitle = ($("title").first().text() || "").trim() || null;
  const h1 = ($("h1").first().text() || "").replace(/\s+/g, " ").trim() || null;
  const h2 = ($("h2").first().text() || "").replace(/\s+/g, " ").trim() || null;
  const footerName = extractFooterCopyrightName($);

  const program_name = pickBest([ogTitle, h1, docTitle, h2, footerName], opts.platform);
  const offer_summary = firstNonEmpty([ogDesc, metaDesc, h2]);
  const price = extractPrice($);

  const raw_text_for_llm = bodyText($).slice(0, 4000);

  const good_enough =
    !!program_name &&
    program_name.length >= 5 &&
    program_name.length <= 50 &&
    !/\s\|\s/.test(program_name) &&
    !BAD_TITLES.has(program_name.toLowerCase());

  return { program_name, offer_summary, price, raw_text_for_llm, good_enough };
}

function pickBest(candidates: (string | null)[], platform: string): string | null {
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (BAD_TITLES.has(trimmed.toLowerCase())) continue;
    if (trimmed.toLowerCase() === platform.toLowerCase()) continue;
    if (trimmed.length < 3 || trimmed.length > 200) continue;
    if (isJunk(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function firstNonEmpty(values: (string | null)[]): string | null {
  for (const v of values) {
    if (v && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  return null;
}

function extractPrice($: cheerio.CheerioAPI): string | null {
  const text = $("body").text();
  const m =
    text.match(/\$\s?[\d]{1,3}(?:,\d{3})+(?:\.\d{2})?/) ||
    text.match(/\$\s?[\d]{2,5}(?:\.\d{2})?/);
  return m ? m[0].replace(/\s/g, "") : null;
}

function bodyText($: cheerio.CheerioAPI): string {
  $("script, style, noscript, svg, nav, footer").remove();
  return ($("body").text() || "").replace(/\s+/g, " ").trim();
}

// Looks for "© 2024 Program Name" in the page footer.
function extractFooterCopyrightName($: cheerio.CheerioAPI): string | null {
  const footerEl = $("footer, [class*='footer'], [id*='footer'], [class*='Footer'], [id*='Footer']").first();
  const raw = footerEl.length
    ? footerEl.text()
    : $("body").text().slice(-2000); // fallback: bottom of body text
  const text = raw.replace(/\s+/g, " ").trim();

  // Match: © [year[-year]] Name [LLC|Inc.|Ltd.|All rights|…]
  const m = text.match(/©\s*(?:\d{4}(?:[-–]\d{2,4})?\s+)?([A-Za-z0-9 &'.,-]{3,60}?)(?:\s+(?:LLC|Inc\.|Ltd\.|All rights|Privacy|Terms|\|)|\s*\.?\s*$)/);
  if (!m) return null;
  const name = m[1].trim().replace(/\.$/, "").trim();
  if (name.length < 3 || name.length > 60) return null;
  return name;
}
