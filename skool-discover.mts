/**
 * Discover Instagram handles from Skool communities, add as seeds (notes="Skool").
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SERPER_API_KEY=... \
 *   npx tsx skool-discover.mts [--batch N] [--offset N] [--dry-run]
 *
 * Defaults: first 25 communities, offset 0.
 * Uses free Skool page scrape first; falls back to Serper (costs 1 credit).
 */

import * as fs from "fs";
import { createAdminClient } from "@/lib/supabase/admin";
import { toUsername, profileUrl } from "@/lib/pipeline/normalize";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const batchSize = Number(args[args.indexOf("--batch") + 1] ?? 25) || 25;
const offset    = Number(args[args.indexOf("--offset") + 1] ?? 0) || 0;
const dryRun    = args.includes("--dry-run");

// ── Inline scraping helpers (avoids server-only imports) ────────────────────

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

async function freeFetchPage(url: string, timeoutMs = 10_000): Promise<{ html: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, headers: FETCH_HEADERS, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    return { html };
  } catch {
    return null;
  }
}

const IG_LINK_RE = /instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?(?:\?[^"'\s]*)?["'\s]/g;
const IG_RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts",
  "about", "help", "legal", "privacy", "safety", "press", "direct",
  "directory", "login", "challenge", "oauth", "api",
]);

function extractIgFromHtml(html: string): string | null {
  IG_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IG_LINK_RE.exec(html)) !== null) {
    const u = m[1].toLowerCase();
    if (!IG_RESERVED.has(u)) return u;
  }
  return null;
}

function extractOwnerFromHtml(html: string): string | null {
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (nd) {
    try {
      const str = JSON.stringify(JSON.parse(nd[1]));
      const m = str.match(/"(?:ownerName|creatorName|fullName|displayName|owner_name)"\s*:\s*"([^"]{2,50})"/);
      if (m) return m[1];
    } catch {}
  }
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
           ?? html.match(/<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/i);
  if (og) {
    const by = og[1].match(/\bby\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b/i);
    if (by) return by[1];
  }
  return null;
}

const OWNER_PATTERNS = [
  /created by\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/i,
  /\bby\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b/,
  /from\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/i,
  /with\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/i,
  /w\/\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/i,
];

function extractOwnerFromDesc(desc: string): string | null {
  for (const re of OWNER_PATTERNS) {
    const m = desc.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

async function serperFindIg(query: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `"${query}" site:instagram.com`, num: 5, gl: "us", hl: "en" }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { organic?: Array<{ link?: string }> };
    for (const item of json.organic ?? []) {
      if (!item.link) continue;
      const m = item.link.match(/instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?(\?.*)?$/);
      if (!m) continue;
      const u = m[1].toLowerCase();
      if (!IG_RESERVED.has(u)) return u;
    }
  } catch {}
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

const SCRATCHPAD = "/private/tmp/claude-501/-Users-tokki-Documents-Files-repositories-leads-scraper-ig/71c904b2-104c-4644-8126-101d21cfb417/scratchpad";
const communities: Array<{ name: string; slug: string; description: string }> =
  JSON.parse(fs.readFileSync(`${SCRATCHPAD}/skool-communities.json`, "utf-8"));

const batch = communities.slice(offset, offset + batchSize);
console.log(`\nProcessing communities ${offset + 1}–${offset + batch.length} of ${communities.length}${dryRun ? " [DRY RUN]" : ""}\n`);

const serperKey = process.env.SERPER_API_KEY ?? "";
if (!serperKey) console.warn("⚠  SERPER_API_KEY not set — will skip Serper fallback\n");

const sb = createAdminClient();

let pageHits = 0, serperHits = 0, misses = 0, skipped = 0;
const results: Array<{ communityName: string; slug: string; username: string; source: "page" | "serper" }> = [];

for (const community of batch) {
  process.stdout.write(`  ${community.name} (${community.slug}) … `);

  // Step 1: free page scrape
  const page = await freeFetchPage(`https://www.skool.com/${community.slug}/about`);
  let username: string | null = null;
  let ownerName: string | null = null;

  if (page) {
    username = extractIgFromHtml(page.html);
    ownerName = extractOwnerFromHtml(page.html);
  }

  if (username) {
    console.log(`✓ page → @${username}${ownerName ? ` (${ownerName})` : ""}`);
    pageHits++;
    results.push({ communityName: community.name, slug: community.slug, username, source: "page" });
    continue;
  }

  // Step 2: Serper fallback
  if (!serperKey) {
    console.log("✗ no Serper key");
    misses++;
    continue;
  }

  const searchTerm = ownerName ?? extractOwnerFromDesc(community.description) ?? community.name;
  username = await serperFindIg(searchTerm, serperKey);

  if (username) {
    console.log(`~ serper → @${username} (searched: "${searchTerm}")`);
    serperHits++;
    results.push({ communityName: community.name, slug: community.slug, username, source: "serper" });
  } else {
    console.log(`✗ not found (searched: "${searchTerm}")`);
    misses++;
  }
}

console.log(`\n── Summary ──────────────────────────────────────────`);
console.log(`  page hits  : ${pageHits}`);
console.log(`  serper hits: ${serperHits}`);
console.log(`  misses     : ${misses}`);
console.log(`  total found: ${results.length} / ${batch.length}`);

if (results.length === 0 || dryRun) {
  if (dryRun) console.log("\n[dry-run] skipping DB inserts");
  process.exit(0);
}

// ── Insert seeds ─────────────────────────────────────────────────────────────
console.log("\nInserting seeds …");

let added = 0;
for (const r of results) {
  const username = toUsername(r.username);
  if (!username) { skipped++; continue; }

  const { error } = await sb.from("seeds").insert({
    username,
    profile_url: profileUrl(username),
    notes: "Skool",
  });

  if (error) {
    if (error.message.includes("duplicate")) {
      // Already a seed — update notes to tag it as Skool
      await sb.from("seeds").update({ notes: "Skool" }).eq("username", username);
      console.log(`  ↻ ${username} already exists — tagged Skool`);
    } else {
      console.log(`  ✗ ${username}: ${error.message}`);
    }
    skipped++;
  } else {
    console.log(`  + ${username}`);
    added++;
  }
}

console.log(`\nDone. Added ${added} new seeds, skipped ${skipped}.`);
