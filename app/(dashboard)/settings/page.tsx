import { getSettings } from "@/lib/config/settings";
import { checkYoutubeCookieLive } from "@/lib/youtube/refresh-cookie";
import { persistYtCookieStatuses } from "@/app/actions/settings";
import { SettingsForm } from "@/components/settings/settings-form";
import type { ManagedAccount, ManagedAccountDisplay } from "@/lib/types";

export const dynamic = "force-dynamic";

function stripAccount(a: ManagedAccount): ManagedAccountDisplay {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id: a.id, label: a.label, account_email: a.account_email ?? null, password: a.password, totp_secret: a.totp_secret, cookie: a.cookie, cookie_set_at: a.cookie_set_at, last_error: a.last_error, checkpoint_state: (a.checkpoint_state ?? null) as any, proxy_url: a.proxy_url ?? null, group: a.group ?? null, paused: a.paused ?? false };
}

export default async function SettingsPage() {
  const settings = await getSettings(true);

  const manualCookies = settings.yt_google_cookies ?? [];
  const accountCookies = (settings.yt_accounts ?? []).map((a) => a.cookie ?? "");
  const allCookies = [...manualCookies, ...accountCookies];
  const ytCookieLiveness = await Promise.all(allCookies.map(checkYoutubeCookieLive));
  void persistYtCookieStatuses(allCookies, ytCookieLiveness);

  const igAccounts: ManagedAccountDisplay[] = (settings.instagram_accounts ?? []).map(stripAccount);
  const ytAccounts: ManagedAccountDisplay[] = (settings.yt_accounts ?? []).map(stripAccount);

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">API keys, search settings, and keyword filters.</p>
      </div>
      <SettingsForm
        initial={settings}
        ytCookieLiveness={ytCookieLiveness}
        igAccounts={igAccounts}
        ytAccounts={ytAccounts}
      />
    </div>
  );
}
