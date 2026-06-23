"use server";
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSettings, updateSettings } from "@/lib/config/settings";
import type { AppSettings, ManagedAccount } from "@/lib/types";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

const num = (v: FormDataEntryValue | null, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const csv = (v: FormDataEntryValue | null): string[] =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function saveSettings(prev: AppSettings, formData: FormData) {
  await requireUser();
  const patch: Partial<AppSettings> = {
    apify_api_key: String(formData.get("apify_api_key") ?? "") || null,
    claude_api_key: String(formData.get("claude_api_key") ?? "") || null,
    claude_model: String(formData.get("claude_model") ?? prev.claude_model),
    scrapingbee_api_key: String(formData.get("scrapingbee_api_key") ?? "") || null,
    serper_api_key: String(formData.get("serper_api_key") ?? "") || null,
    max_profiles_per_account: num(formData.get("max_profiles_per_account"), prev.max_profiles_per_account),
    crawl_score_threshold: num(formData.get("crawl_score_threshold"), prev.crawl_score_threshold),
    min_followers: num(formData.get("min_followers"), prev.min_followers),
    max_followers: num(formData.get("max_followers"), prev.max_followers),
    min_engagement_rate: num(formData.get("min_engagement_rate"), prev.min_engagement_rate),
    min_posts_last_30_days: num(formData.get("min_posts_last_30_days"), prev.min_posts_last_30_days),
    min_reels_last_30_days: num(formData.get("min_reels_last_30_days"), prev.min_reels_last_30_days),
    include_keywords: csv(formData.get("include_keywords")),
    exclude_keywords: csv(formData.get("exclude_keywords")),
    following_scraper_provider: (() => {
      const raw = formData.get("following_scraper_provider");
      if (raw == null) return prev.following_scraper_provider; // field not in form — keep DB value
      const v = String(raw);
      return (["playwright", "apify", "scrapingbee", "cookie", "auto"] as const).includes(v as never) ? (v as "playwright" | "apify" | "scrapingbee" | "cookie" | "auto") : "auto";
    })(),
    instagram_session_cookie: String(formData.get("instagram_session_cookie") ?? "") || null,
    scoring_provider: (() => {
      const v = String(formData.get("scoring_provider") ?? "openai");
      return v === "claude" ? "claude" : "openai";
    })(),
    openai_api_key: String(formData.get("openai_api_key") ?? "") || null,
    openai_model: String(formData.get("openai_model") ?? prev.openai_model),
    enrich_funnels_auto: formData.get("enrich_funnels_auto") === "on",
    enrich_emails_auto: formData.get("enrich_emails_auto") === "on",
    outreach_subject_template: String(formData.get("outreach_subject_template") ?? prev.outreach_subject_template),
    outreach_body_template: String(formData.get("outreach_body_template") ?? prev.outreach_body_template),
    outreach_reply_to: String(formData.get("outreach_reply_to") ?? "") || null,
    gmail_user: String(formData.get("gmail_user") ?? "") || null,
    gmail_app_password: String(formData.get("gmail_app_password") ?? "") || null,
    gmail_from_name: String(formData.get("gmail_from_name") ?? "") || null,
    capsolver_api_key: String(formData.get("capsolver_api_key") ?? "") || null,
    hunter_api_key: String(formData.get("hunter_api_key") ?? "") || null,
    zerobounce_api_key: String(formData.get("zerobounce_api_key") ?? "") || null,
    neverbounce_api_key: String(formData.get("neverbounce_api_key") ?? "") || null,
    yt_google_cookie: String(formData.get("yt_google_cookie") ?? "") || null,
  };
  await updateSettings(patch);

  // YouTube auto-login credentials live in columns added by a later migration.
  // Update them separately and tolerate failure, so a DB that hasn't run that
  // migration yet doesn't break the entire settings save.
  try {
    await updateSettings({
      yt_google_email: String(formData.get("yt_google_email") ?? "") || null,
      yt_google_password: String(formData.get("yt_google_password") ?? "") || null,
      yt_google_totp_secret: String(formData.get("yt_google_totp_secret") ?? "") || null,
    });
  } catch {
    // columns not present yet — ignore
  }

  // Gmail OAuth app credentials (added by the gmail_oauth migration). Only
  // overwrite when a non-empty value is submitted so saving other settings
  // never wipes the stored secret. The refresh token is set by the OAuth
  // callback, not here.
  try {
    const oauthPatch: Record<string, string> = {};
    const cid = String(formData.get("gmail_oauth_client_id") ?? "").trim();
    const secret = String(formData.get("gmail_oauth_client_secret") ?? "").trim();
    if (cid) oauthPatch.gmail_oauth_client_id = cid;
    if (secret) oauthPatch.gmail_oauth_client_secret = secret;
    if (Object.keys(oauthPatch).length > 0) await updateSettings(oauthPatch);
  } catch {
    // columns not present yet — ignore
  }

  revalidatePath("/settings");
  return { ok: true };
}

export async function addBurnerCookie(cookie: string) {
  await requireUser();
  const settings = await getSettings(true);
  const trimmed = cookie.trim();
  if (!trimmed) return { error: "Cookie is empty" };
  const cookies = settings.instagram_session_cookies ?? [];
  if (cookies.includes(trimmed)) return { error: "Cookie already added" };
  await updateSettings({ instagram_session_cookies: [...cookies, trimmed] });
  revalidatePath("/settings");
  return { ok: true };
}

export async function removeBurnerCookie(index: number) {
  await requireUser();
  const settings = await getSettings(true);
  const cookies = [...(settings.instagram_session_cookies ?? [])];
  if (index < 0 || index >= cookies.length) return;
  cookies.splice(index, 1);
  await updateSettings({ instagram_session_cookies: cookies });
  revalidatePath("/settings");
}

export async function addYtCookie(cookie: string) {
  await requireUser();
  const settings = await getSettings(true);
  const trimmed = cookie.trim();
  if (!trimmed) return { error: "Cookie is empty" };
  const cookies = settings.yt_google_cookies ?? [];
  if (cookies.includes(trimmed)) return { error: "Cookie already added" };
  await updateSettings({ yt_google_cookies: [...cookies, trimmed] });
  revalidatePath("/settings");
  return { ok: true };
}

export async function removeYtCookie(index: number) {
  await requireUser();
  const settings = await getSettings(true);
  const cookies = [...(settings.yt_google_cookies ?? [])];
  if (index < 0 || index >= cookies.length) return;
  cookies.splice(index, 1);
  await updateSettings({ yt_google_cookies: cookies });
  revalidatePath("/settings");
}

const KEY_FIELD: Record<string, keyof AppSettings> = {
  findymail:   "findymail_api_keys",
  prospeo:     "prospeo_api_keys",
  scrapingbee: "scrapingbee_api_keys",
  apify:       "apify_api_keys",
};

export async function addEmailProviderKey(provider: "findymail" | "prospeo" | "scrapingbee" | "apify", key: string) {
  await requireUser();
  const settings = await getSettings(true);
  const trimmed = key.trim();
  if (!trimmed) return { error: "Key is empty" };
  const field = KEY_FIELD[provider];
  const keys: string[] = (settings[field] as string[]) ?? [];
  if (keys.includes(trimmed)) return { error: "Key already added" };
  await updateSettings({ [field]: [...keys, trimmed] });
  revalidatePath("/settings");
  return { ok: true };
}

export async function removeEmailProviderKey(provider: "findymail" | "prospeo" | "scrapingbee" | "apify", index: number) {
  await requireUser();
  const settings = await getSettings(true);
  const field = KEY_FIELD[provider];
  const keys = [...((settings[field] as string[]) ?? [])];
  if (index < 0 || index >= keys.length) return;
  keys.splice(index, 1);
  await updateSettings({ [field]: keys });
  revalidatePath("/settings");
}

export async function refreshYtCookieNow(creds?: {
  email?: string;
  password?: string;
  totpSecret?: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireUser();

  // When the caller supplies credentials directly (from the form fields),
  // save them to DB first and then drive the login directly — this bypasses
  // the in-memory cooldown that throttles background/cron refreshes, which is
  // the right behaviour for an explicit user-initiated "Login now" click.
  if (creds?.email && creds?.password) {
    try {
      await updateSettings({
        yt_google_email: creds.email,
        yt_google_password: creds.password,
        yt_google_totp_secret: creds.totpSecret || null,
      });
    } catch {
      // columns not present yet — ignore
    }
    const { loginAndExtractCookie } = await import("@/lib/youtube/refresh-cookie");
    try {
      const sb = (await import("@/lib/supabase/admin")).createAdminClient();
      const cookie = await loginAndExtractCookie({
        email: creds.email,
        password: creds.password,
        totpSecret: creds.totpSecret || null,
      });
      await sb.from("app_settings").update({ yt_google_cookie: cookie }).eq("id", 1);
      revalidatePath("/settings");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // No creds in the call — fall back to the standard refresh that reads from DB.
  const { refreshAndSaveYoutubeCookie } = await import("@/lib/youtube/refresh-cookie");
  const result = await refreshAndSaveYoutubeCookie();
  if (result.cookie) {
    revalidatePath("/settings");
    return { ok: true };
  }
  return { ok: false, error: result.error ?? "Login failed" };
}

// ── Instagram cookie validation ───────────────────────────────────────────────

async function testInstagramCookieString(
  cookie: string,
  username?: string,
  proxyUrl?: string | null,
): Promise<{ ok: boolean; message: string }> {
  const probe = username ?? "natgeo";
  try {
    const { fetchProfileMetadataDirect } = await import("@/lib/instagram/direct");
    const meta = await fetchProfileMetadataDirect({ username: probe, sessionCookie: cookie, skipReels: true, proxyUrl: proxyUrl ?? null });
    if (!meta) return { ok: false, message: "Cookie may be invalid — Instagram returned no user data" };
    const proxyNote = proxyUrl ? " (via proxy)" : "";
    return { ok: true, message: `Cookie valid${proxyNote} — fetched @${probe} (${meta.followers?.toLocaleString()} followers)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429")) return { ok: true, message: "Cookie looks valid (rate-limited on probe, but session is active)" };
    if (msg.includes("407")) return { ok: false, message: "Proxy authentication failed (407) — check the proxy URL credentials" };
    if (msg.includes("401") || msg.includes("403") || msg.includes("login_required")) {
      return { ok: false, message: "Cookie rejected by Instagram — session expired or invalid" };
    }
    return { ok: false, message: `Cookie rejected: ${msg}` };
  }
}

// ── Managed account CRUD (Instagram + YouTube) ────────────────────────────────

type Platform = "instagram" | "youtube";

function accountsKey(platform: Platform): "instagram_accounts" | "yt_accounts" {
  return platform === "instagram" ? "instagram_accounts" : "yt_accounts";
}

async function loginManaged(platform: Platform, account: ManagedAccount): Promise<{ cookie: string } | { checkpoint: true; state: import("@/lib/types").CheckpointState; message: string }> {
  if (platform === "instagram") {
    const { loginInstagramPlaywright } = await import("@/lib/instagram/login-playwright");
    const settings = await getSettings(true);
    const result = await loginInstagramPlaywright({
      username: account.label,
      password: account.password,
      totp_secret: account.totp_secret,
      capsolver_api_key: settings.capsolver_api_key ?? null,
    });
    if (result.ok) return { cookie: result.cookie };
    if (result.checkpoint) return { checkpoint: true, state: result.state, message: result.message };
    throw new Error(result.error);
  }
  const { loginAndExtractCookie } = await import("@/lib/youtube/refresh-cookie");
  const cookie = await loginAndExtractCookie({ email: account.label, password: account.password, totpSecret: account.totp_secret });
  return { cookie };
}

export async function addManagedAccount(
  platform: Platform,
  data: { label: string; account_email?: string; password?: string; totp_secret?: string; cookie?: string; group?: string },
): Promise<{ ok?: true; error?: string; checkpoint?: boolean }> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];

  if (accounts.some((a) => a.label === data.label)) {
    return { error: "Account already added" };
  }

  if (!data.password && !data.cookie) {
    return { error: "Provide either a session cookie or a password" };
  }

  const id = crypto.randomUUID();

  // Cookie-paste flow: save directly, then validate.
  if (data.cookie) {
    const trimmed = data.cookie.trim();
    const normalised = trimmed.includes("sessionid=") ? trimmed : `sessionid=${trimmed}`;

    let cookieError: string | null = null;
    if (platform === "instagram") {
      const result = await testInstagramCookieString(normalised, data.label);
      if (!result.ok) cookieError = result.message;
    }

    const newAccount: ManagedAccount = {
      id,
      label: data.label,
      account_email: data.account_email || null,
      password: data.password || "",
      totp_secret: data.totp_secret || null,
      cookie: normalised,
      cookie_set_at: new Date().toISOString(),
      last_error: cookieError,
      checkpoint_state: null,
      proxy_url: null,
      group: data.group || null,
    };
    await updateSettings({ [key]: [...accounts, newAccount] } as Partial<AppSettings>);
    revalidatePath("/settings");
    if (cookieError) return { error: cookieError };
    return { ok: true };
  }

  // Auto-login flow: attempt login with password.
  const newAccount: ManagedAccount = {
    id,
    label: data.label,
    account_email: data.account_email || null,
    password: data.password!,
    totp_secret: data.totp_secret || null,
    cookie: null,
    cookie_set_at: null,
    last_error: null,
    checkpoint_state: null,
    proxy_url: null,
    group: data.group || null,
  };

  // Save the account first so it shows up in the list even if login fails.
  await updateSettings({ [key]: [...accounts, newAccount] } as Partial<AppSettings>);

  try {
    const result = await loginManaged(platform, newAccount);
    const fresh = await getSettings(true);
    if ("checkpoint" in result) {
      const updated = ((fresh[key] as ManagedAccount[]) ?? []).map((a) =>
        a.id === id ? { ...a, checkpoint_state: result.state, last_error: result.message } : a,
      );
      await updateSettings({ [key]: updated } as Partial<AppSettings>);
      revalidatePath("/settings");
      return { error: result.message, checkpoint: true };
    }
    const updated = ((fresh[key] as ManagedAccount[]) ?? []).map((a) =>
      a.id === id ? { ...a, cookie: result.cookie, cookie_set_at: new Date().toISOString(), last_error: null, checkpoint_state: null } : a,
    );
    await updateSettings({ [key]: updated } as Partial<AppSettings>);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const fresh = await getSettings(true);
    const updated = ((fresh[key] as ManagedAccount[]) ?? []).map((a) =>
      a.id === id ? { ...a, last_error: error } : a,
    );
    await updateSettings({ [key]: updated } as Partial<AppSettings>);
    revalidatePath("/settings");
    return { error };
  }

  revalidatePath("/settings");
  return { ok: true };
}

export async function submitCheckpointCode(
  platform: Platform,
  id: string,
  code: string,
): Promise<{ ok?: true; error?: string }> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const account = accounts.find((a) => a.id === id);
  if (!account) return { error: "Account not found" };
  if (!account.checkpoint_state) return { error: "No checkpoint in progress" };

  const { submitInstagramCheckpointCode } = await import("@/lib/instagram/login-playwright");
  const result = await submitInstagramCheckpointCode(account.checkpoint_state, code);

  if (!result.ok) {
    const errMsg = "error" in result ? result.error : result.message;
    const updated = accounts.map((a) => a.id === id ? { ...a, last_error: errMsg } : a);
    await updateSettings({ [key]: updated } as Partial<AppSettings>);
    revalidatePath("/settings");
    return { error: errMsg };
  }

  const updated = accounts.map((a) =>
    a.id === id ? { ...a, cookie: result.cookie, cookie_set_at: new Date().toISOString(), last_error: null, checkpoint_state: null } : a,
  );
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
  return { ok: true };
}

export async function testManagedAccountCookie(
  platform: Platform,
  id: string,
): Promise<{ ok: boolean; message: string; refreshed?: boolean; checkpoint?: boolean }> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const account = accounts.find((a) => a.id === id);
  if (!account?.cookie) return { ok: false, message: "No cookie saved for this account" };

  if (platform === "instagram") {
    const result = await testInstagramCookieString(account.cookie, account.label, account.proxy_url);

    if (result.ok) {
      const updated = accounts.map((a) => a.id === id ? { ...a, last_error: null } : a);
      await updateSettings({ [key]: updated } as Partial<AppSettings>);
      revalidatePath("/settings");
      return result;
    }

    // Cookie is dead — mark it, then attempt auto re-login if a password is stored.
    if (!account.password) {
      const updated = accounts.map((a) => a.id === id ? { ...a, last_error: result.message } : a);
      await updateSettings({ [key]: updated } as Partial<AppSettings>);
      revalidatePath("/settings");
      return { ok: false, message: result.message };
    }

    // Has password — try to re-login now.
    try {
      const loginResult = await loginManaged(platform, account);
      if ("checkpoint" in loginResult) {
        const updated = accounts.map((a) =>
          a.id === id ? { ...a, checkpoint_state: loginResult.state, last_error: loginResult.message } : a,
        );
        await updateSettings({ [key]: updated } as Partial<AppSettings>);
        revalidatePath("/settings");
        return { ok: false, message: loginResult.message, checkpoint: true };
      }
      const updated = accounts.map((a) =>
        a.id === id ? { ...a, cookie: loginResult.cookie, cookie_set_at: new Date().toISOString(), last_error: null, checkpoint_state: null } : a,
      );
      await updateSettings({ [key]: updated } as Partial<AppSettings>);
      revalidatePath("/settings");
      return { ok: true, message: "Cookie was invalid — re-logged in successfully.", refreshed: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const updated = accounts.map((a) => a.id === id ? { ...a, last_error: error } : a);
      await updateSettings({ [key]: updated } as Partial<AppSettings>);
      revalidatePath("/settings");
      return { ok: false, message: `Cookie invalid. Re-login failed: ${error}` };
    }
  }

  return { ok: false, message: "Test not supported for this platform" };
}

export async function setManagedAccountCookie(platform: Platform, id: string, cookie: string): Promise<{ ok?: true; error?: string }> {
  await requireUser();
  const trimmed = cookie.trim();
  if (!trimmed) return { error: "Cookie is empty" };
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  if (!accounts.find((a) => a.id === id)) return { error: "Account not found" };
  // Normalise: user may paste just the sessionid value or the full cookie string
  const normalised = trimmed.includes("sessionid=") ? trimmed : `sessionid=${trimmed}`;
  const updated = accounts.map((a) =>
    a.id === id ? { ...a, cookie: normalised, cookie_set_at: new Date().toISOString(), checkpoint_state: null, last_error: null } : a,
  );
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
  return { ok: true };
}

export async function setManagedAccountEmail(platform: Platform, id: string, email: string): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const updated = accounts.map((a) => a.id === id ? { ...a, account_email: email.trim() || null } : a);
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
}

export async function setManagedAccountPassword(
  platform: Platform,
  id: string,
  password: string,
  totp_secret: string | null,
): Promise<{ ok?: true; error?: string }> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const updated = accounts.map((a) =>
    a.id === id ? { ...a, password: password.trim(), totp_secret: totp_secret?.trim() || null } : a,
  );
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
  return { ok: true };
}

export async function setManagedAccountProxy(platform: Platform, id: string, proxyUrl: string): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const updated = accounts.map((a) => a.id === id ? { ...a, proxy_url: proxyUrl.trim() || null } : a);
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
}

export async function setManagedAccountGroup(platform: Platform, id: string, group: string | null): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const updated = accounts.map((a) => a.id === id ? { ...a, group: group?.trim() || null } : a);
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
}

export async function setActiveAccountGroup(group: string | null): Promise<void> {
  await requireUser();
  await updateSettings({ active_account_group: group?.trim() || null });
  revalidatePath("/settings");
}

export async function setProxyPool(proxies: string[]): Promise<void> {
  await requireUser();
  const cleaned = proxies.map((p) => p.trim()).filter(Boolean);
  await updateSettings({ instagram_proxy_pool: cleaned });
  revalidatePath("/settings");
}

export async function removeManagedAccount(platform: Platform, id: string): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  await updateSettings({ [key]: accounts.filter((a) => a.id !== id) } as Partial<AppSettings>);
  revalidatePath("/settings");
}

export async function addInstagramGroup(name: string): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const groups = settings.instagram_groups ?? [];
  if (!groups.includes(name)) {
    await updateSettings({ instagram_groups: [...groups, name] });
  }
  revalidatePath("/settings");
}

export async function removeInstagramGroup(name: string): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const groups = (settings.instagram_groups ?? []).filter((g) => g !== name);
  await updateSettings({ instagram_groups: groups });
  revalidatePath("/settings");
}

export async function refreshManagedAccount(
  platform: Platform,
  id: string,
): Promise<{ ok?: true; error?: string; checkpoint?: boolean }> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const account = accounts.find((a) => a.id === id);
  if (!account) return { error: "Account not found" };

  try {
    const result = await loginManaged(platform, account);
    console.log("[refreshManagedAccount]", account.label, "result keys:", Object.keys(result));
    if ("checkpoint" in result) {
      console.log("[refreshManagedAccount] saving checkpoint_state for", account.label);
      const updated = accounts.map((a) =>
        a.id === id ? { ...a, checkpoint_state: result.state, last_error: result.message } : a,
      );
      await updateSettings({ [key]: updated } as Partial<AppSettings>);
      revalidatePath("/settings");
      return { error: result.message, checkpoint: true };
    }
    const updated = accounts.map((a) =>
      a.id === id ? { ...a, cookie: result.cookie, cookie_set_at: new Date().toISOString(), last_error: null, checkpoint_state: null } : a,
    );
    await updateSettings({ [key]: updated } as Partial<AppSettings>);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[refreshManagedAccount] error for", account.label, error);
    const updated = accounts.map((a) => (a.id === id ? { ...a, last_error: error } : a));
    await updateSettings({ [key]: updated } as Partial<AppSettings>);
    revalidatePath("/settings");
    return { error };
  }

  revalidatePath("/settings");
  return { ok: true };
}
