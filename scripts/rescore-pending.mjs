// Re-score all `pending` leads through the lightweight scorer (no re-scrape).
// Fires `lead/score.requested` per lead; the score-lead Inngest function uses
// the bio/recent_posts already stored on the row. ~$0.0001 per lead.
//
// PREREQ: the Next app must be running (npm run dev) so /api/inngest is
// registered with the Inngest dev server — otherwise events aren't consumed.
//
// Usage:
//   node scripts/rescore-pending.mjs            # all pending leads
//   node scripts/rescore-pending.mjs 50         # cap at 50

import { readFileSync } from "node:fs";

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* optional */ }
  return out;
}

const env = { ...loadEnv(".env.local"), ...process.env };
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const INNGEST_DEV_URL = env.INNGEST_DEV_URL || "http://localhost:8288";
const EVENT_KEY = env.INNGEST_EVENT_KEY || "local";
const cap = process.argv[2] ? Number(process.argv[2]) : null;

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
let url = `${URL}/rest/v1/leads?status=eq.pending&select=id,username&order=created_at.desc`;
if (cap) url += `&limit=${cap}`;
const leads = await (await fetch(url, { headers: H })).json();
if (!leads.length) { console.log("No pending leads."); process.exit(0); }

let ok = 0;
for (const l of leads) {
  const r = await fetch(`${INNGEST_DEV_URL}/e/${EVENT_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "lead/score.requested", data: { lead_id: l.id } }),
  });
  if (r.ok) { ok++; } else { console.error(`  failed ${l.username}: HTTP ${r.status}`); }
}
console.log(`Queued ${ok}/${leads.length} lead/score.requested events to ${INNGEST_DEV_URL}.`);
