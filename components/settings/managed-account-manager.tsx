"use client";
import { useTransition, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, RefreshCw, Trash2, Eye, EyeOff, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useRouter } from "next/navigation";
import { addManagedAccount, refreshManagedAccount, submitCheckpointCode, setManagedAccountEmail, testManagedAccountCookie, setManagedAccountCookie, setManagedAccountProxy, setManagedAccountPassword } from "@/app/actions/settings";
import type { ManagedAccountDisplay } from "@/lib/types";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusLabel(account: ManagedAccountDisplay): { color: string; text: string; Icon: React.ElementType } {
  if (account.checkpoint_state) return { color: "text-amber-600", text: "Verification needed", Icon: AlertTriangle };
  if (account.cookie && !account.last_error) return { color: "text-green-600", text: "Active", Icon: CheckCircle2 };
  if (account.cookie && account.last_error) return { color: "text-destructive", text: "Cookie invalid", Icon: XCircle };
  if (!account.cookie && account.last_error) return { color: "text-destructive", text: "Login failed", Icon: XCircle };
  return { color: "text-muted-foreground", text: "Not logged in", Icon: MinusCircle };
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-muted-foreground hover:text-foreground transition-colors"
      aria-label="Copy cookie"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function AccountCard({
  account,
  platform,
  onRefresh,
  onRemove,
  refreshing,
}: {
  account: ManagedAccountDisplay;
  platform: "instagram" | "youtube";
  onRefresh: () => void;
  onRemove: () => void;
  refreshing: boolean;
}) {
  const isCheckpoint = !!account.checkpoint_state;
  const { color, text, Icon } = statusLabel(account);
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [emailDraft, setEmailDraft] = useState(account.account_email ?? "");
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingCookie, setSavingCookie] = useState(false);
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [proxyDraft, setProxyDraft] = useState(account.proxy_url ?? "");
  const [savingProxy, setSavingProxy] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState(account.password ?? "");
  const [totpDraft, setTotpDraft] = useState(account.totp_secret ?? "");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordResult, setPasswordResult] = useState<string | null>(null);

  // Parse existing cookie string into individual fields
  function parseCookieField(cookie: string | null | undefined, key: string): string {
    if (!cookie) return "";
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
    return m ? m[1].trim().replace(/^"|"$/g, "") : "";
  }
  const [sessionId, setSessionId] = useState(() => parseCookieField(account.cookie, "sessionid"));
  const [csrfToken, setCsrfToken] = useState(() => parseCookieField(account.cookie, "csrftoken"));
  const [dsUserId, setDsUserId] = useState(() => parseCookieField(account.cookie, "ds_user_id"));
  const [rur, setRur] = useState(() => parseCookieField(account.cookie, "rur"));
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const router = useRouter();

  const handleSaveEmail = async () => {
    setSavingEmail(true);
    await setManagedAccountEmail(platform, account.id, emailDraft);
    setSavingEmail(false);
    router.refresh();
  };

  const assembleCookie = () => {
    const parts: string[] = [];
    if (sessionId.trim()) parts.push(`sessionid=${sessionId.trim()}`);
    if (csrfToken.trim()) parts.push(`csrftoken=${csrfToken.trim()}`);
    if (dsUserId.trim()) parts.push(`ds_user_id=${dsUserId.trim()}`);
    if (rur.trim()) parts.push(`rur="${rur.trim().replace(/^"|"$/g, "")}"`);
    return parts.join("; ");
  };

  const cookieChanged = assembleCookie() !== (account.cookie ?? "");

  const handleSaveCookie = async () => {
    setSavingCookie(true);
    setCookieError(null);
    const result = await setManagedAccountCookie(platform, account.id, assembleCookie());
    setSavingCookie(false);
    if (result.error) {
      setCookieError(result.error);
    } else {
      router.refresh();
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testManagedAccountCookie(platform, account.id);
    if (res.checkpoint) {
      // Checkpoint state is saved in DB — reload to show the verification box.
      window.location.reload();
      return;
    }
    setTestResult(res);
    setTesting(false);
    if (res.refreshed) router.refresh();
  };

  const handleCodeSubmit = async () => {
    setSubmittingCode(true);
    setCodeError(null);
    const res = await submitCheckpointCode(platform, account.id, code);
    if (res.error) {
      setCodeError(res.error);
    } else {
      setCode("");
      router.refresh();
    }
    setSubmittingCode(false);
  };

  return (
    <div className="rounded-md border bg-card">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />
          <span className="text-sm font-medium truncate">@{account.label}</span>
          {account.account_email && (
            <span className="text-xs text-muted-foreground shrink-0 truncate max-w-[160px]" title={account.account_email}>
              {account.account_email}
            </span>
          )}
          <span className={`text-xs ${color} shrink-0`}>{text}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            · refreshed {relativeTime(account.cookie_set_at)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted-foreground mr-1">Remove?</span>
              <Button type="button" size="sm" variant="destructive" className="h-7 px-2 text-xs"
                onClick={onRemove}>Yes</Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
                onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <>
              {platform === "instagram" && account.cookie && (
                <Button
                  type="button" size="sm" variant="ghost" disabled={testing}
                  onClick={handleTest} className="h-7 px-2 text-xs"
                >
                  {testing ? "Checking…" : "Test"}
                </Button>
              )}
              <Button
                type="button" size="icon" variant="ghost"
                onClick={() => setConfirmDelete(true)} aria-label="Remove account" className="h-7 w-7"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {testResult && (
        <div className={`px-3 py-1.5 text-xs border-t ${testResult.ok ? "text-green-600" : "text-destructive"}`}>
          {testResult.message}
        </div>
      )}

      {/* Cookie row — collapsed by default */}
      <div className="border-t bg-muted/30 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>{platform === "instagram" ? "Session cookie" : "Google cookie"}</span>
            <span className="text-muted-foreground/60">{expanded ? "▲" : "▼"}</span>
          </button>
          {account.cookie && expanded && <CopyButton value={account.cookie} />}
        </div>

        {expanded && (
          <div className="mt-2 space-y-2">
            {platform === "instagram" ? (
              <>
                {([
                  { label: "Session ID", value: sessionId, set: setSessionId, placeholder: "395860815%3ADkb0mm…" },
                  { label: "CSRF Token", value: csrfToken, set: setCsrfToken, placeholder: "RID2FZQRbCj…" },
                  { label: "ds_user_id", value: dsUserId, set: setDsUserId, placeholder: "395860815" },
                  { label: "RUR", value: rur, set: setRur, placeholder: "CLN\\054…" },
                ] as const).map(({ label, value, set, placeholder }) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-20 shrink-0">{label}</span>
                    <Input
                      value={value}
                      onChange={(e) => { (set as (v: string) => void)(e.target.value); setCookieError(null); }}
                      placeholder={placeholder}
                      className="h-7 text-xs font-mono flex-1"
                    />
                  </div>
                ))}
              </>
            ) : (
              <textarea
                value={assembleCookie()}
                onChange={(e) => {
                  const v = e.target.value;
                  setSessionId(v);
                  setCookieError(null);
                }}
                placeholder="Paste full cookie string"
                rows={3}
                className="w-full font-mono text-xs text-foreground/80 bg-background border rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
            {cookieError && <p className="text-xs text-destructive">{cookieError}</p>}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={savingCookie || !cookieChanged}
              onClick={handleSaveCookie}
            >
              {savingCookie ? "Saving…" : "Save cookie"}
            </Button>
          </div>
        )}

{/* Inline email field — always visible so user can set it without re-adding the account */}
        {platform === "instagram" && (
          <div className="flex items-center gap-2 mt-2">
            <Input
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="Account email (shown during verification)"
              type="email"
              className="h-7 text-xs flex-1"
              onKeyDown={(e) => e.key === "Enter" && !savingEmail && handleSaveEmail()}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={savingEmail || emailDraft === (account.account_email ?? "")}
              onClick={handleSaveEmail}
            >
              {savingEmail ? "Saving…" : "Save"}
            </Button>
          </div>
        )}

        {/* Per-account proxy — routes all requests for this account through a dedicated residential IP */}
        {platform === "instagram" && (
          <div className="flex items-center gap-2 mt-2">
            <Input
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
              placeholder="Proxy: http://user:pass@host:port (optional)"
              className="h-7 text-xs flex-1 font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={savingProxy || proxyDraft === (account.proxy_url ?? "")}
              onClick={async () => {
                setSavingProxy(true);
                await setManagedAccountProxy(platform, account.id, proxyDraft);
                setSavingProxy(false);
                router.refresh();
              }}
            >
              {savingProxy ? "Saving…" : "Save"}
            </Button>
          </div>
        )}

        {/* Password — stored server-side for auto-refresh via Playwright */}
        {platform === "instagram" && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Auto-refresh credentials</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-20 shrink-0">Password</span>
              <Input
                type="text"
                value={passwordDraft}
                onChange={(e) => { setPasswordDraft(e.target.value); setPasswordResult(null); }}
                placeholder="Instagram password"
                autoComplete="new-password"
                className="h-7 text-xs flex-1 font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-20 shrink-0">TOTP secret</span>
              <Input
                value={totpDraft}
                onChange={(e) => setTotpDraft(e.target.value)}
                placeholder="TOTP secret (optional, for 2FA)"
                className="h-7 text-xs flex-1 font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
                disabled={savingPassword || !passwordDraft.trim()}
                onClick={async () => {
                  setSavingPassword(true);
                  setPasswordResult(null);
                  const res = await setManagedAccountPassword(platform, account.id, passwordDraft, totpDraft || null);
                  setSavingPassword(false);
                  if (res.ok) { setPasswordResult("Saved — cookie will auto-refresh every 12h"); }
                  else setPasswordResult(res.error ?? "Failed to save");
                }}
              >
                {savingPassword ? "Saving…" : "Save password"}
              </Button>
              {passwordResult && (
                <span className={`text-xs ${passwordResult.startsWith("Saved") ? "text-green-600" : "text-destructive"}`}>
                  {passwordResult}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Checkpoint verification row */}
      {isCheckpoint && (
        <div className="border-t px-3 py-2.5 space-y-2.5">
          {account.account_email || account.checkpoint_state?.email_hint ? (
            <p className="text-xs text-amber-600 font-medium">
              Instagram sent a verification code to{" "}
              <span className="font-mono font-semibold">
                {account.account_email || account.checkpoint_state?.email_hint}
              </span>. Enter it below:
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs text-amber-600 font-medium">
                Instagram sent a verification code for{" "}
                <span className="font-mono">@{account.label}</span>.
                What email is linked to this account?
              </p>
              <div className="flex gap-2">
                <Input
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  placeholder="email@example.com"
                  type="email"
                  className="h-7 text-xs flex-1"
                  onKeyDown={(e) => e.key === "Enter" && !savingEmail && handleSaveEmail()}
                />
                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                  disabled={savingEmail || !emailDraft.includes("@")} onClick={handleSaveEmail}>
                  {savingEmail ? "…" : "Save"}
                </Button>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              maxLength={8}
              className="h-8 text-sm font-mono w-36"
              onKeyDown={(e) => e.key === "Enter" && !submittingCode && handleCodeSubmit()}
            />
            <Button
              type="button"
              size="sm"
              disabled={submittingCode || code.length < 4}
              onClick={handleCodeSubmit}
              className="h-8"
            >
              {submittingCode ? "Verifying…" : "Verify"}
            </Button>
          </div>
          {codeError && <p className="text-xs text-destructive">{codeError}</p>}
        </div>
      )}

      {/* Error row */}
      {account.last_error && !isCheckpoint && (
        <div className="border-t px-3 py-1.5">
          <p className="text-xs text-destructive" title={account.last_error}>
            Last error: {account.last_error}
          </p>
        </div>
      )}
    </div>
  );
}

export function ManagedAccountManager({
  platform,
  accounts,
  onPendingDelete,
}: {
  platform: "instagram" | "youtube";
  accounts: ManagedAccountDisplay[];
  onPendingDelete?: (id: string) => void;
}) {
  const isIg = platform === "instagram";
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());

  type TestAllResult = { ok: boolean; message: string };
  const [testingAllId, setTestingAllId] = useState<string | null>(null);
  const [testAllResults, setTestAllResults] = useState<Record<string, TestAllResult>>({});

  const [label, setLabel] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [newSessionId, setNewSessionId] = useState("");
  const [newCsrfToken, setNewCsrfToken] = useState("");
  const [newDsUserId, setNewDsUserId] = useState("");
  const [newRur, setNewRur] = useState("");
  const [password, setPassword] = useState("");
  const [igPassword, setIgPassword] = useState("");
  const [igTotp, setIgTotp] = useState("");
  const [showIgPw, setShowIgPw] = useState(false);

  const assembleNewCookie = () => {
    const parts: string[] = [];
    if (newSessionId.trim()) parts.push(`sessionid=${newSessionId.trim()}`);
    if (newCsrfToken.trim()) parts.push(`csrftoken=${newCsrfToken.trim()}`);
    if (newDsUserId.trim()) parts.push(`ds_user_id=${newDsUserId.trim()}`);
    if (newRur.trim()) parts.push(`rur="${newRur.trim().replace(/^"|"$/g, "")}"`);
    return parts.join("; ");
  };
  const [showPw, setShowPw] = useState(false);
  const [addPending, startAdd] = useTransition();
  const [addResult, setAddResult] = useState<{ ok?: true; error?: string } | null>(null);

  const router = useRouter();

  const setRefreshing = (id: string, val: boolean) =>
    setRefreshingIds((prev) => { const s = new Set(prev); val ? s.add(id) : s.delete(id); return s; });

  const handleRefresh = async (id: string) => {
    setRefreshing(id, true);
    try {
      const result = await refreshManagedAccount(platform, id);
      if (result.checkpoint) {
        // checkpoint_state is now saved in DB — hard reload guarantees the verify box appears
        window.location.reload();
        return;
      }
      router.refresh();
    } finally {
      setRefreshing(id, false);
    }
  };

  // Queue the deletion locally — parent commits it on form Save, cancels on Discard.
  const handleRemove = (id: string) => {
    setPendingDeleteIds((prev) => { const s = new Set(prev); s.add(id); return s; });
    onPendingDelete?.(id);
  };

  const handleTestAll = async () => {
    const visible = accounts.filter((a) => !pendingDeleteIds.has(a.id) && !!a.cookie);
    setTestAllResults({});
    for (const account of visible) {
      setTestingAllId(account.id);
      const res = await testManagedAccountCookie(platform, account.id);
      if (res.checkpoint) {
        window.location.reload();
        return;
      }
      setTestAllResults((prev) => ({ ...prev, [account.id]: res }));
      if (res.refreshed) router.refresh();
    }
    setTestingAllId(null);
    router.refresh();
  };

  const handleAdd = () => {
    if (!label.trim()) return;
    if (isIg && !newSessionId.trim() && !igPassword.trim()) return;
    if (!isIg && !password.trim()) return;
    setAddResult(null);
    startAdd(async () => {
      const res = await addManagedAccount(platform, {
        label: label.trim(),
        account_email: accountEmail.trim() || undefined,
        cookie: isIg && newSessionId.trim() ? assembleNewCookie() : undefined,
        password: isIg ? (igPassword.trim() || undefined) : password.trim(),
        totp_secret: isIg ? (igTotp.trim() || undefined) : undefined,
      });
      setAddResult(res ?? { ok: true });
      if (res.ok) {
        setLabel(""); setAccountEmail(""); setNewSessionId(""); setNewCsrfToken(""); setNewDsUserId(""); setNewRur("");
        setPassword(""); setIgPassword(""); setIgTotp("");
        window.location.reload();
      }
    });
  };

  const visibleAccounts = accounts.filter((a) => !pendingDeleteIds.has(a.id));
  const isTesting = testingAllId !== null;

  return (
    <div className="space-y-3">
      {/* Header row with Test all button */}
      {isIg && visibleAccounts.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">Accounts</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={isTesting}
            onClick={() => void handleTestAll()}
          >
            {isTesting ? (
              <>
                <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
                Testing @{accounts.find((a) => a.id === testingAllId)?.label}…
              </>
            ) : "Test all"}
          </Button>
        </div>
      )}

      {/* One card per account — hide ones queued for deletion */}
      {visibleAccounts.map((account) => (
        <div key={account.id}>
          <AccountCard
            account={account}
            platform={platform}
            refreshing={refreshingIds.has(account.id)}
            onRefresh={() => void handleRefresh(account.id)}
            onRemove={() => handleRemove(account.id)}
          />
          {testAllResults[account.id] && (
            <p className={`text-xs px-1 pt-1 ${testAllResults[account.id].ok ? "text-green-600" : "text-destructive"}`}>
              {testAllResults[account.id].message}
            </p>
          )}
        </div>
      ))}

      {accounts.length > 0 && <Separator />}

      {/* Add account form */}
      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Add account</p>

        {/* Username + email always shown */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${platform}-label`} className="text-xs">
              {isIg ? "Instagram username" : "Google email"}
            </Label>
            <Input
              id={`${platform}-label`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={isIg ? "your_handle" : "burner@gmail.com"}
              autoComplete="off"
              className="h-8 text-sm"
            />
          </div>
          {isIg && (
            <div className="space-y-1">
              <Label htmlFor={`${platform}-email`} className="text-xs">Account email</Label>
              <Input
                id={`${platform}-email`}
                type="email"
                value={accountEmail}
                onChange={(e) => setAccountEmail(e.target.value)}
                placeholder="email@example.com"
                autoComplete="off"
                className="h-8 text-sm"
              />
            </div>
          )}
        </div>

        {/* Cookie fields — Chrome: F12 → Application → Cookies → instagram.com */}
        {isIg && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              Session cookie{" "}
              <span className="text-muted-foreground font-normal">— F12 → Application → Cookies → instagram.com</span>
            </Label>
            {([
              { label: "Session ID", id: "sessionid", value: newSessionId, set: setNewSessionId, placeholder: "395860815%3ADkb0mm…", required: true },
              { label: "CSRF Token", id: "csrftoken", value: newCsrfToken, set: setNewCsrfToken, placeholder: "RID2FZQRbCj…", required: false },
              { label: "ds_user_id", id: "ds_user_id", value: newDsUserId, set: setNewDsUserId, placeholder: "395860815", required: false },
              { label: "RUR",        id: "rur",        value: newRur,      set: setNewRur,      placeholder: "CLN\\054…", required: false },
            ] as const).map(({ label, id, value, set, placeholder, required }) => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-20 shrink-0">
                  {label}{required && <span className="text-destructive ml-0.5">*</span>}
                </span>
                <Input
                  value={value}
                  onChange={(e) => (set as (v: string) => void)(e.target.value)}
                  placeholder={placeholder}
                  autoComplete="off"
                  className="h-7 text-xs font-mono flex-1"
                />
              </div>
            ))}
          </div>
        )}

        {/* IG password — optional, enables auto-refresh */}
        {isIg && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              Password <span className="text-muted-foreground font-normal">— optional, enables auto-refresh every 12h</span>
            </Label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-20 shrink-0">Password</span>
              <div className="relative flex-1">
                <Input
                  type={showIgPw ? "text" : "password"}
                  value={igPassword}
                  onChange={(e) => setIgPassword(e.target.value)}
                  placeholder="Instagram password"
                  autoComplete="new-password"
                  className="h-7 text-xs pr-7"
                />
                <button type="button" tabIndex={-1} onClick={() => setShowIgPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showIgPw ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-20 shrink-0">TOTP secret</span>
              <Input
                value={igTotp}
                onChange={(e) => setIgTotp(e.target.value)}
                placeholder="TOTP secret (optional, for 2FA accounts)"
                className="h-7 text-xs flex-1 font-mono"
              />
            </div>
          </div>
        )}

        {/* YouTube: keep original password form */}
        {!isIg && (
          <div className="space-y-1">
            <Label htmlFor={`${platform}-pw`} className="text-xs">Password</Label>
            <div className="relative">
              <Input
                id={`${platform}-pw`}
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="h-8 text-sm pr-8"
              />
              <button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={addPending || !label.trim() || (isIg ? (!newSessionId.trim() && !igPassword.trim()) : !password.trim())}
            onClick={handleAdd}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${addPending ? "animate-spin" : ""}`} />
            {addPending ? "Saving…" : "Add account"}
          </Button>

          {addResult?.ok && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Account saved
            </span>
          )}
          {addResult?.error && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              <span className="line-clamp-2">{addResult.error}</span>
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {isIg
          ? "The scraper rotates between accounts automatically when one gets rate-limited."
          : "The enrichment pipeline cycles through accounts for YouTube email reveal. Cookies auto-refresh every 12h."}
      </p>
    </div>
  );
}
