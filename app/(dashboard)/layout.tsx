import Link from "next/link";
import { LayoutDashboard, Users, Settings, ScrollText, Sprout, LogOut, Gauge, CreditCard, Inbox } from "lucide-react";
import { signOut } from "@/app/actions/auth";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/seeds", label: "Source Accounts", icon: Sprout },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/logs", label: "Activity", icon: ScrollText },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/billing", label: "Costs", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] min-h-screen">
      <aside className="border-r bg-muted/20 flex flex-col">
        <div className="px-5 py-4 border-b">
          <Link href="/" className="font-semibold tracking-tight text-lg">
            leads<span className="text-muted-foreground">.scraper</span>
          </Link>
        </div>
        <nav className="flex-1 p-2 space-y-1">
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
      </aside>
      <main className="overflow-auto">{children}</main>
    </div>
  );
}
