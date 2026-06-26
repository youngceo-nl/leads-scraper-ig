import Link from "next/link";
import { Instagram, Youtube, Mail, Send } from "lucide-react";

type CookieStatus = "ok" | "unknown" | "missing" | "dead";

export type SystemStatusProps = {
  igStatus: CookieStatus;
  ytStatus: CookieStatus;
  emailKeysOk: boolean;
  gmailOk: boolean;
};

// ok = green, unknown = gray, missing = amber, dead = red
function StatusDot({ status }: { status: CookieStatus | "simple-ok" | "simple-missing" }) {
  if (status === "ok" || status === "simple-ok")      return <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />;
  if (status === "unknown")                            return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" />;
  if (status === "missing" || status === "simple-missing") return <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />;
}

const COOKIE_LABEL: Record<CookieStatus, (prefix: string) => string> = {
  ok:      (p) => p,
  unknown: (p) => `${p}: not verified`,
  missing: (p) => `${p}: no cookie`,
  dead:    (p) => `${p}: expired`,
};

export function SystemStatus({ igStatus, ytStatus, emailKeysOk, gmailOk }: SystemStatusProps) {
  const items = [
    { icon: Instagram, label: COOKIE_LABEL[igStatus]("IG"), dot: igStatus,                                              href: "/settings#instagram" },
    { icon: Youtube,   label: COOKIE_LABEL[ytStatus]("YT"), dot: ytStatus,                                              href: "/settings#youtube" },
    { icon: Mail, label: emailKeysOk ? "Email keys" : "No email keys", dot: emailKeysOk ? "simple-ok" : "simple-missing", href: "/settings#email" },
    { icon: Send, label: gmailOk     ? "Gmail"      : "Gmail: not set", dot: gmailOk     ? "simple-ok" : "simple-missing", href: "/settings#outreach" },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-2 py-1.5">
      {items.map(({ icon: Icon, label, dot, href }) => (
        <Link
          key={label}
          href={href}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors py-0.5"
        >
          <StatusDot status={dot as CookieStatus} />
          <Icon className="h-3 w-3 shrink-0" />
          <span>{label}</span>
        </Link>
      ))}
    </div>
  );
}
