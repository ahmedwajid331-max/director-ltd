"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, LogOut, Plus, Database } from "lucide-react";
import type { UserRole } from "@/lib/types";
import { visibleNavItems, findActiveNavItem } from "@/lib/nav";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/profile/Avatar";

const ROLE_RANK: Record<UserRole, number> = { USER: 0, ADMIN: 1, SUPER_ADMIN: 2 };

// Product shell: a two-row header (brand + actions, then primary navigation) over a centred content area,
// the same structure as a company-data platform rather than an admin sidebar.
export function AppShell({
  role,
  permissions,
  userName,
  userEmail,
  avatarSrc,
  realCompanyCount,
  children,
}: {
  role: UserRole;
  permissions: string[];
  userName: string;
  userEmail: string;
  avatarSrc: string | null;
  realCompanyCount: number;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const items = visibleNavItems({ role, permissions }, ROLE_RANK);
  const activeHref = findActiveNavItem(pathname, items)?.href;
  const primary = items.filter((i) => !i.secondary);
  const secondary = items.filter((i) => i.secondary);

  const link = (item: (typeof items)[number], mobile = false) => {
    const active = item.href === activeHref;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileOpen(false)}
        aria-current={active ? "page" : undefined}
        className={cn(
          mobile
            ? "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium"
            : "relative flex h-10 items-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium transition-colors",
          active
            ? mobile
              ? "bg-indigo-50 text-indigo-700"
              : "text-indigo-700 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-indigo-600"
            : mobile
              ? "text-slate-600 hover:bg-slate-50"
              : "text-slate-600 hover:text-slate-900"
        )}
      >
        {mobile && <Icon className={cn("h-4 w-4", active ? "text-indigo-600" : "text-slate-400")} />}
        {item.label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(900px_420px_at_50%_-120px,rgba(47,107,255,0.07),transparent)]">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="app-container flex h-14 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden">
              <Menu className="h-5 w-5" />
            </button>
            <Link href="/dashboard" className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">DL</span>
              <span className="leading-tight">
                <span className="block text-[15px] font-bold tracking-tight text-slate-900">DIRECTOR.LTD</span>
                <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-500">UK company intelligence</span>
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <span
              className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 xl:inline-flex"
              title="Companies loaded from the official Companies House register"
            >
              <Database className="h-3.5 w-3.5 text-slate-400" />
              <span className="font-semibold tabular-nums text-slate-800">{realCompanyCount.toLocaleString()}</span> UK companies
            </span>
            {(role === "SUPER_ADMIN" || permissions.includes("reports.create")) && (
            <Link
              href="/reports/new"
              className="hidden items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-indigo-700 sm:inline-flex"
            >
              <Plus className="h-4 w-4" /> Create report
            </Link>
            )}
            <div className="hidden text-right leading-tight md:block">
              <div className="text-[13px] font-medium text-slate-900">{userName}</div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{role.replace("_", " ")}</div>
            </div>
            <Link href="/settings#profile-picture" title="Change your profile picture" aria-label="Profile picture settings" className="rounded-full focus-ring">
              <Avatar src={avatarSrc} initials={userName.slice(0, 2).toUpperCase()} className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-600" />
            </Link>
            <form action="/api/auth/logout" method="POST">
              <button title={`Sign out (${userEmail})`} aria-label="Sign out" className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>

        <nav aria-label="Primary" className="hidden border-t border-slate-100 lg:block">
          <div className="app-container flex items-center justify-between gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex shrink-0 items-center">{primary.map((i) => link(i))}</div>
            <div className="flex shrink-0 items-center">{secondary.map((i) => link(i))}</div>
          </div>
        </nav>
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
              <span className="text-sm font-bold text-slate-900">DIRECTOR.LTD</span>
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu" className="rounded-md p-1.5 hover:bg-slate-100">
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">{items.map((i) => link(i, true))}</nav>
          </div>
        </div>
      )}

      {/* One shared content column for header, nav and every page: centred, max 1480px, responsive gutters. Wide tables scroll inside their own wrapper. */}
      <main className="app-container py-6 sm:py-8">{children}</main>
    </div>
  );
}
