import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSettings } from "@/lib/config/settings";
import { buildAuthUrl } from "@/lib/google/oauth";

// Kicks off the Gmail OAuth consent flow. Requires a logged-in user and a
// configured OAuth app (client id in Settings). Sets a CSRF state cookie that
// the callback verifies.
export async function GET() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", process.env.APP_URL || "http://localhost:3000"));

  const settings = await getSettings(true);
  const base = process.env.APP_URL || "http://localhost:3000";
  if (!settings.gmail_oauth_client_id) {
    return NextResponse.redirect(new URL("/settings?gmail=missing_client", base));
  }

  const state = crypto.randomUUID();
  const jar = await cookies();
  jar.set("g_oauth_state", state, { httpOnly: true, secure: base.startsWith("https"), sameSite: "lax", path: "/", maxAge: 600 });

  return NextResponse.redirect(buildAuthUrl(settings.gmail_oauth_client_id, state));
}
