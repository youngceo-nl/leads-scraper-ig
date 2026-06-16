import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSettings } from "@/lib/config/settings";
import { exchangeCode, saveGmailConnection } from "@/lib/google/oauth";
import { gmailProfileEmail } from "@/lib/google/gmail-api";

// Completes the OAuth flow: verifies state, exchanges the code for a refresh
// token, records the connected Gmail address, and bounces back to Settings.
export async function GET(req: NextRequest) {
  const base = process.env.APP_URL || "http://localhost:3000";
  const settle = (params: string) => NextResponse.redirect(new URL(`/settings?${params}`, base));

  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", base));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return settle(`gmail=denied`);
  if (!code) return settle(`gmail=no_code`);

  const jar = await cookies();
  const expected = jar.get("g_oauth_state")?.value;
  jar.delete("g_oauth_state");
  if (!expected || expected !== state) return settle(`gmail=bad_state`);

  const settings = await getSettings(true);
  if (!settings.gmail_oauth_client_id || !settings.gmail_oauth_client_secret) {
    return settle(`gmail=missing_client`);
  }

  try {
    const { refreshToken, accessToken } = await exchangeCode({
      clientId: settings.gmail_oauth_client_id,
      clientSecret: settings.gmail_oauth_client_secret,
      code,
    });
    const email = await gmailProfileEmail(accessToken);
    await saveGmailConnection({ refreshToken, email });
    return settle(`gmail=connected`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return settle(`gmail=error&detail=${encodeURIComponent(msg.slice(0, 120))}`);
  }
}
