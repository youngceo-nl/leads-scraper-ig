// One-shot smoke test for the cookie-based following scraper.
// Usage: node --env-file=.env.local scripts/test-following-direct.cjs <username> [limit]
// Reads the cookie from the live Supabase app_settings row.

const username = process.argv[2] || "brezscales";
const limit = Number(process.argv[3] ?? 20);

async function main() {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    console.error("Missing Supabase env vars");
    process.exit(1);
  }

  // Pull cookie from app_settings
  const r = await fetch(`${supaUrl}/rest/v1/app_settings?select=instagram_session_cookie&id=eq.1`, {
    headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
  });
  const rows = await r.json();
  const cookie = rows?.[0]?.instagram_session_cookie?.trim();
  if (!cookie) {
    console.error("No cookie in app_settings — paste one in Settings first");
    process.exit(1);
  }
  console.log(`cookie length: ${cookie.length} chars`);

  const headersWeb = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
    Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
    Cookie: cookie,
  };

  // 1. Resolve user_id
  const t0 = Date.now();
  const wpiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const wpi = await fetch(wpiUrl, { headers: headersWeb });
  const wpiBody = await wpi.text();
  if (!wpi.ok) {
    console.error(`web_profile_info failed: HTTP ${wpi.status}\n${wpiBody.slice(0, 300)}`);
    process.exit(1);
  }
  const wpiJson = JSON.parse(wpiBody);
  const userId = wpiJson?.data?.user?.id;
  const followerCount = wpiJson?.data?.user?.edge_followed_by?.count;
  const followingCount = wpiJson?.data?.user?.edge_follow?.count;
  console.log(`✓ resolved @${username} → user_id=${userId}, followers=${followerCount}, following=${followingCount}`);

  // 2. Page through following
  const headersMobile = {
    "User-Agent":
      "Instagram 291.0.0.29.111 Android (30/11; 480dpi; 1080x2137; samsung; SM-G973F; beyond1; exynos9820; en_US; 493494379)",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
    "Accept-Language": "en-US",
    Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
    Cookie: cookie,
  };

  const out = [];
  let maxId = null;
  let page = 0;
  const PAGE_SIZE = 50;
  const DELAY_MS = 2500;

  while (out.length < limit) {
    const u = new URL(`https://www.instagram.com/api/v1/friendships/${userId}/following/`);
    u.searchParams.set("count", String(PAGE_SIZE));
    if (maxId) u.searchParams.set("max_id", maxId);
    const p0 = Date.now();
    const res = await fetch(u.toString(), { headers: headersMobile });
    const body = await res.text();
    page++;
    if (!res.ok) {
      console.error(`page ${page} HTTP ${res.status}: ${body.slice(0, 300)}`);
      break;
    }
    const j = JSON.parse(body);
    const users = j.users ?? [];
    console.log(`  page ${page}: ${users.length} users in ${Date.now() - p0}ms`);
    for (const usr of users) {
      out.push({
        username: usr.username,
        full_name: usr.full_name,
        is_private: usr.is_private,
        is_verified: usr.is_verified,
      });
      if (out.length >= limit) break;
    }
    if (!j.next_max_id || users.length === 0) break;
    maxId = j.next_max_id;
    if (out.length < limit) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const totalMs = Date.now() - t0;
  console.log(`\n=== RESULT ===`);
  console.log(`fetched: ${out.length} users in ${totalMs}ms (~${(totalMs / 1000).toFixed(1)}s)`);
  console.log(`first 5:`, out.slice(0, 5));
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
