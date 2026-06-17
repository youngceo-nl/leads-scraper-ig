"use client";
import { useTransition, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, RefreshCw, Trash2, Eye, EyeOff, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useRouter } from "next/navigation";
import { addManagedAccount, refreshManagedAccount, submitCheckpointCode, setManagedAccountEmail, testManagedAccountCookie } from "@/app/actions/settings";
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
  if (account.cookie && account.last_error) return { color: "text-amber-600", text: "Active (refresh failed)", Icon: AlertTriangle };
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
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const router = useRouter();

  const handleSaveEmail = async () => {
    setSavingEmail(true);
    await setManagedAccountEmail(platform, account.id, emailDraft);
    setSavingEmail(false);
    router.refresh();
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testManagedAccountCookie(platform, account.id);
    setTestResult(res);
    setTesting(false);
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
                  {testing ? "Testing…" : "Test"}
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
          <div className="mt-2">
            {account.cookie ? (
              <p className="font-mono text-xs text-foreground/80 break-all leading-relaxed">
                {account.cookie}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground italic">No cookie — log in to generate one</p>
            )}
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

  const [label, setLabel] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [cookiePaste, setCookiePaste] = useState("");
  const [password, setPassword] = useState("");
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

  const handleAdd = () => {
    if (!label.trim()) return;
    if (isIg && !cookiePaste.trim()) return;
    if (!isIg && !password.trim()) return;
    setAddResult(null);
    startAdd(async () => {
      const res = await addManagedAccount(platform, {
        label: label.trim(),
        account_email: accountEmail.trim() || undefined,
        cookie: isIg ? cookiePaste.trim() : undefined,
        password: !isIg ? password.trim() : undefined,
      });
      setAddResult(res ?? { ok: true });
      if (res.ok) {
        setLabel(""); setAccountEmail(""); setCookiePaste(""); setPassword("");
        window.location.reload();
      }
    });
  };

  return (
    <div className="space-y-3">
      {/* One card per account — hide ones queued for deletion */}
      {accounts.filter((a) => !pendingDeleteIds.has(a.id)).map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          platform={platform}
          refreshing={refreshingIds.has(account.id)}
          onRefresh={() => void handleRefresh(account.id)}
          onRemove={() => handleRemove(account.id)}
        />
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

        {/* Primary flow: paste cookie from browser */}
        {isIg && (
          <div className="space-y-1">
            <Label htmlFor={`${platform}-cookie-paste`} className="text-xs">
              Session cookie{" "}
              <span className="text-muted-foreground font-normal">
                — Chrome: F12 → Application → Cookies → instagram.com → copy <code className="text-xs">sessionid</code>
              </span>
            </Label>
            <Input
              id={`${platform}-cookie-paste`}
              value={cookiePaste}
              onChange={(e) => setCookiePaste(e.target.value)}
              placeholder="Paste sessionid value or full cookie string…"
              autoComplete="off"
              className="h-8 text-sm font-mono"
            />
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
            disabled={addPending || !label.trim() || (isIg ? !cookiePaste.trim() : !password.trim())}
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
