import "server-only";
import { getSettings, updateSettings } from "@/lib/config/settings";

/**
 * Merges Set-Cookie response headers back into a flat "name=value; name=value"
 * cookie request string. Google rotates session tokens on every authenticated
 * response — if we discard those Set-Cookie headers the stored cookie goes stale
 * in ~30 minutes and subsequent requests get a logged-out response.
 *
 * Returns the updated cookie string, or null if nothing changed.
 */
export function mergeCookiesFromResponse(existing: string, headers: Headers): string | null {
  const setCookies: string[] =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=[^ ])/).filter(Boolean);

  if (!setCookies.length) return null;

  // Parse existing cookie string into a name → value map, preserving order.
  const order: string[] = [];
  const map = new Map<string, string>();
  for (const chunk of existing.split(/;\s*/)) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const name = chunk.slice(0, eq).trim();
    if (!name || map.has(name)) continue;
    order.push(name);
    map.set(name, chunk.slice(eq + 1));
  }

  let changed = false;
  for (const sc of setCookies) {
    // Format: "name=value; Path=/; HttpOnly; Secure; ..."
    const semi = sc.indexOf(";");
    const nameVal = (semi >= 0 ? sc.slice(0, semi) : sc).trim();
    const eq = nameVal.indexOf("=");
    if (eq < 0) continue;
    const name = nameVal.slice(0, eq).trim();
    const value = nameVal.slice(eq + 1);
    if (!name || !value) continue; // skip deletions (value empty = expired)
    if (map.get(name) !== value) {
      if (!map.has(name)) order.push(name);
      map.set(name, value);
      changed = true;
    }
  }

  if (!changed) return null;
  return order.map((k) => `${k}=${map.get(k)}`).join("; ");
}

/**
 * Saves a refreshed cookie back to wherever the original cookie lived —
 * yt_accounts first (matched by current cookie value), then yt_google_cookies.
 * Call this whenever attemptYoutubeEmail returns a non-null updatedCookie.
 * Fire-and-forget safe: errors are swallowed so they don't break the pipeline.
 */
export async function persistRefreshedYtCookie(oldCookie: string, newCookie: string): Promise<void> {
  try {
    const settings = await getSettings(true);
    const accounts = settings.yt_accounts ?? [];
    const accountIdx = accounts.findIndex((a) => a.cookie?.trim() === oldCookie);
    if (accountIdx >= 0) {
      const updated = accounts.map((a, i) =>
        i === accountIdx ? { ...a, cookie: newCookie, cookie_set_at: new Date().toISOString() } : a,
      );
      await updateSettings({ yt_accounts: updated });
      return;
    }
    const cookies = settings.yt_google_cookies ?? [];
    const cookieIdx = cookies.findIndex((c) => c.trim() === oldCookie);
    if (cookieIdx >= 0) {
      const updated = [...cookies];
      updated[cookieIdx] = newCookie;
      await updateSettings({ yt_google_cookies: updated });
    }
  } catch {
    // Don't let a cookie save failure break enrichment
  }
}
