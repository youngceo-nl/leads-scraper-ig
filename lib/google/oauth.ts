import "server-only";
import { getSettings, updateSettings } from "@/lib/config/settings";

// Minimal Google OAuth 2.0 client (fetch-based, no googleapis dependency).
//
// Flow: the user creates a one-time OAuth app in Google Cloud, pastes the
// client id/secret into Settings, then authorizes once. We keep only the
// refresh token; access tokens are minted on demand and cached in memory.
//
// Scopes: gmail.send (send) + gmail.readonly (read reply bodies).
// readonly is the narrowest scope that returns message bodies — Gmail has no
// "only my threads" scope — so the read constraint is enforced in our code:
// reply sync reads threads we started and searches only for mail FROM the
// addresses we emailed, never the broader personal mailbox.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function redirectUri(): string {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/google/oauth/callback`;
}

// Build the consent-screen URL. `prompt=consent` + `access_type=offline`
// guarantees Google returns a refresh token (not just on first authorization).
export function buildAuthUrl(clientId: string, state: string): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  // Deliberately NOT include_granted_scopes — we want the grant limited to
  // exactly GOOGLE_SCOPES (send + readonly), never merged with broader scopes
  // the account may have granted this project before.
  u.searchParams.set("state", state);
  return u.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

// Exchange the one-time auth code for tokens. Returns the refresh token, which
// the caller persists; the access token is short-lived and re-minted as needed.
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<{ refreshToken: string; accessToken: string }> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`token exchange failed: ${json.error_description || json.error || res.status}`);
  }
  if (!json.refresh_token) {
    throw new Error("Google did not return a refresh token — re-authorize with prompt=consent.");
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

// In-memory access-token cache keyed by refresh token (resets on restart).
const accessCache = new Map<string, { token: string; exp: number }>();

// Mint (or reuse) a short-lived access token from the stored refresh token.
async function accessTokenFromRefresh(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const cached = accessCache.get(opts.refreshToken);
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`token refresh failed: ${json.error_description || json.error || res.status}`);
  }
  const ttl = (json.expires_in ?? 3600) * 1000;
  accessCache.set(opts.refreshToken, { token: json.access_token, exp: Date.now() + ttl });
  return json.access_token;
}

export function gmailOAuthConfigured(s: Awaited<ReturnType<typeof getSettings>>): boolean {
  return !!(s.gmail_oauth_client_id && s.gmail_oauth_client_secret && s.gmail_oauth_refresh_token);
}

// Resolve a ready-to-use access token from stored settings. Throws a clear,
// actionable error when the Gmail app isn't connected yet.
export async function getGmailAccessToken(): Promise<{ accessToken: string; email: string }> {
  const s = await getSettings();
  if (!s.gmail_oauth_client_id || !s.gmail_oauth_client_secret) {
    throw new Error("Gmail OAuth app not configured — add the Client ID and Secret in Settings → Outreach.");
  }
  if (!s.gmail_oauth_refresh_token) {
    throw new Error("Gmail not connected — click “Connect Gmail” in Settings → Outreach to authorize sending.");
  }
  const accessToken = await accessTokenFromRefresh({
    clientId: s.gmail_oauth_client_id,
    clientSecret: s.gmail_oauth_client_secret,
    refreshToken: s.gmail_oauth_refresh_token,
  });
  return { accessToken, email: s.gmail_oauth_email || "" };
}

// Persist the tokens + connected address after a successful authorization.
export async function saveGmailConnection(opts: {
  refreshToken: string;
  email: string;
}): Promise<void> {
  await updateSettings({
    gmail_oauth_refresh_token: opts.refreshToken,
    gmail_oauth_email: opts.email,
  });
}
