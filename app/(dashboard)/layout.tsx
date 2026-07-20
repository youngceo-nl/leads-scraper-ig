import Link from "next/link";
import { LayoutDashboard, Users, Settings, Sprout, LogOut, Activity, MailCheck } from "lucide-react";
import { signOut } from "@/app/actions/auth";
import { ActivityDrawerButton } from "@/components/logs/activity-drawer";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/seeds", label: "Source Accounts", icon: Sprout },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/outreach-ready", label: "Outreach Ready", icon: MailCheck },
  { href: "/logs", label: "Pipeline", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] h-screen overflow-hidden">
      <aside className="border-r bg-muted/20 overflow-y-auto">
        <div className="px-5 py-4 border-b">
          <Link href="/" className="font-semibold tracking-tight text-lg">
            leads<span className="text-muted-foreground">.scraper</span>
          </Link>
        </div>
        <div className="sticky top-0 bg-muted/20">
          <nav className="p-2 space-y-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors"
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}

            {/* Activity — opens a live slide-out drawer instead of navigating away */}
            <ActivityDrawerButton />
          </nav>
          <form action={signOut} className="p-2 border-t">
            <button
              type="submit"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-accent w-full"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="overflow-auto">{children}</main>
    </div>
  );
}
