import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

// Proactively re-mints Instagram session cookies for all managed accounts on a
// schedule so they're renewed before they expire. Requires a browser runtime.
// No-ops cleanly when no managed accounts are configured.
export const refreshIgCookies = inngest.createFunction(
  { id: "refresh-ig-cookies", name: "Refresh Instagram managed cookies", retries: 1 },
  { cron: "30 */12 * * *" }, // twice a day, offset from the YT refresh
  async ({ step }) => {
    const accounts = await step.run("load-accounts", async () => {
      const sb = createAdminClient();
      const { data } = await sb.from("app_settings").select("instagram_accounts").eq("id", 1).single();
      return (data as { instagram_accounts?: unknown })?.instagram_accounts as Array<{
        id: string; label: string; password: string; totp_secret: string | null;
        cookie: string | null; cookie_set_at: string | null; last_error: string | null;
      }> ?? [];
    });

    if (!accounts.length) return { skipped: "no managed Instagram accounts" };

    const results = await step.run("refresh-all", async () => {
      const { loginInstagramPlaywright } = await import("@/lib/instagram/login-playwright");
      const sb = createAdminClient();
      let refreshed = 0;
      let failed = 0;
      const updated = [...accounts];

      for (let i = 0; i < updated.length; i++) {
        const account = updated[i];
        if (!account.password) { failed++; continue; }
        try {
          const result = await loginInstagramPlaywright({
            username: account.label,
            password: account.password,
            totp_secret: account.totp_secret,
          });
          if (result.ok) {
            updated[i] = { ...account, cookie: result.cookie, cookie_set_at: new Date().toISOString(), last_error: null };
            refreshed++;
          } else {
            updated[i] = { ...account, last_error: result.checkpoint ? result.message : result.error };
            failed++;
          }
        } catch (err) {
          updated[i] = { ...account, last_error: err instanceof Error ? err.message : String(err) };
          failed++;
        }
      }

      await sb.from("app_settings").update({ instagram_accounts: updated }).eq("id", 1);
      return { refreshed, failed };
    });

    if (results.failed > 0 && results.refreshed === 0) {
      throw new Error(`All ${results.failed} Instagram account(s) failed to refresh`);
    }
    return results;
  },
);
