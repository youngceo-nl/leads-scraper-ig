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
    max_profiles_per_account: num(formData.get("max_profiles_per_account"), prev.max_profiles_per_account),
    crawl_score_threshold: num(formData.get("crawl_score_threshold"), prev.crawl_score_threshold),
    min_followers: num(formData.get("min_followers"), prev.min_followers),
    max_followers: num(formData.get("max_followers"), prev.max_followers),
    min_engagement_rate: num(formData.get("min_engagement_rate"), prev.min_engagement_rate),
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
      return (["claude", "gemini", "groq"] as const).includes(v as never) ? (v as "claude" | "gemini" | "groq") : "openai";
    })(),
    openai_api_key: String(formData.get("openai_api_key") ?? "") || null,
    openai_model: String(formData.get("openai_model") ?? prev.openai_model),
    gemini_api_key: String(formData.get("gemini_api_key") ?? "") || null,
    gemini_model: String(formData.get("gemini_model") ?? prev.gemini_model),
    groq_api_key: String(formData.get("groq_api_key") ?? "") || null,
    groq_model: String(formData.get("groq_model") ?? prev.groq_model),
    capsolver_api_key: String(formData.get("capsolver_api_key") ?? "") || null,
  };
  await updateSettings(patch);

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

const KEY_FIELD: Record<string, keyof AppSettings> = {
  scrapingbee: "scrapingbee_api_keys",
  apify:       "apify_api_keys",
};

export async function addEmailProviderKey(provider: "scrapingbee" | "apify", key: string) {
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

export async function removeEmailProviderKey(provider: "scrapingbee" | "apify", index: number) {
  await requireUser();
  const settings = await getSettings(true);
  const field = KEY_FIELD[provider];
  const keys = [...((settings[field] as string[]) ?? [])];
  if (index < 0 || index >= keys.length) return;
  keys.splice(index, 1);
  await updateSettings({ [field]: keys });
  revalidatePath("/settings");
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

// ── Managed account CRUD (Instagram) ──────────────────────────────────────────

type Platform = "instagram";

function accountsKey(_platform: Platform): "instagram_accounts" {
  return "instagram_accounts";
}

async function loginManaged(_platform: Platform, account: ManagedAccount): Promise<{ cookie: string } | { checkpoint: true; state: import("@/lib/types").CheckpointState; message: string }> {
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

export async function setManagedAccountPaused(platform: Platform, id: string, paused: boolean): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const updated = accounts.map((a) => a.id === id ? { ...a, paused } : a);
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
}

// Pause or resume every account in a group at once.
export async function setGroupPaused(platform: Platform, group: string, paused: boolean): Promise<void> {
  await requireUser();
  const settings = await getSettings(true);
  const key = accountsKey(platform);
  const accounts: ManagedAccount[] = (settings[key] as ManagedAccount[]) ?? [];
  const updated = accounts.map((a) =>
    (a.group?.trim() || null) === group.trim() ? { ...a, paused } : a
  );
  await updateSettings({ [key]: updated } as Partial<AppSettings>);
  revalidatePath("/settings");
}

// Fire-and-forget from scraping flows to track whether the IG session cookie is working.
export async function persistIgCookieStatus(status: "live" | "dead"): Promise<void> {
  try {
    await updateSettings({ ig_cookie_status: status });
  } catch { /* non-fatal */ }
}

// ── Email provider key status ─────────────────────────────────────────────────

function emailKeyStatusId(provider: string, key: string) {
  return `${provider}:${key.slice(-12)}`;
}

async function probeKey(provider: "apify" | "scrapingbee", key: string): Promise<import("@/lib/types").EmailKeyStatus> {
  const now = new Date().toISOString();
  try {
    if (provider === "apify") {
      const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return { status: "invalid", checkedAt: now };
      if (!res.ok) return { status: "ok", checkedAt: now };
      return { status: "ok", checkedAt: now };
    }

    if (provider === "scrapingbee") {
      // ScrapingBee has no lightweight status endpoint; validate by fetching usage
      const res = await fetch(`https://app.scrapingbee.com/api/v1/usage?api_key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return { status: "invalid", checkedAt: now };
      if (!res.ok) return { status: "ok", checkedAt: now };
      const body = await res.json() as { max_api_credit?: number; used_api_credit?: number };
      const remaining = body.max_api_credit != null && body.used_api_credit != null
        ? body.max_api_credit - body.used_api_credit
        : null;
      if (remaining !== null && remaining <= 0) return { status: "exhausted", credits: 0, checkedAt: now };
      return { status: "ok", credits: remaining ?? undefined, checkedAt: now };
    }
  } catch {
    // network error — don't clobber existing status
  }
  return { status: "ok", checkedAt: now };
}

export async function checkEmailProviderKey(
  provider: "apify" | "scrapingbee",
  rawKey: string,
): Promise<import("@/lib/types").EmailKeyStatus> {
  await requireUser();
  // rawKey may be "label|||key" — extract just the key part
  const sepIdx = rawKey.indexOf("|||");
  const key = sepIdx === -1 ? rawKey : rawKey.slice(sepIdx + 3);
  const result = await probeKey(provider, key);
  // Persist
  const settings = await getSettings(true);
  const statuses = { ...(settings.email_key_statuses ?? {}) };
  statuses[emailKeyStatusId(provider, key)] = result;
  await updateSettings({ email_key_statuses: statuses });
  revalidatePath("/settings");
  return result;
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

export async function refreshManagedAccountMobile(
  id: string,
): Promise<{ ok?: true; error?: string }> {
  await requireUser();
  const settings = await getSettings(true);
  const accounts: ManagedAccount[] = (settings.instagram_accounts as ManagedAccount[]) ?? [];
  const account = accounts.find((a) => a.id === id);
  if (!account) return { error: "Account not found" };
  if (!account.password) return { error: "No password saved — add a password first" };
  try {
    const { loginInstagramMobile } = await import("@/lib/instagram/login-mobile");
    const result = await loginInstagramMobile({
      username: account.label,
      password: account.password,
      totp_secret: account.totp_secret,
    });
    if (!result.ok) return { error: "error" in result ? result.error : result.message };
    const updated = accounts.map((a) =>
      a.id === id ? { ...a, cookie: result.cookie, cookie_set_at: new Date().toISOString(), last_error: null } : a,
    );
    await updateSettings({ instagram_accounts: updated });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const updated = accounts.map((a) => (a.id === id ? { ...a, last_error: error } : a));
    await updateSettings({ instagram_accounts: updated });
    revalidatePath("/settings");
    return { error };
  }
  revalidatePath("/settings");
  return { ok: true };
}

