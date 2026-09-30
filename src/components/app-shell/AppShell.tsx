"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, LogOut } from "lucide-react";
import type { UserRole } from "@/lib/types";
import { NAV_ITEMS, findActiveNavItem } from "@/lib/nav";
import { cn } from "@/lib/cn";
import { Sidebar } from "./Sidebar";

const ROLE_RANK: Record<UserRole, number> = { USER: 0, ADMIN: 1, SUPER_ADMIN: 2 };

export function AppShell({
  role,
  userName,
  userEmail,
  realCompanyCount,
  children,
}: {
  role: UserRole;
  userName: string;
  userEmail: string;
  realCompanyCount: number;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  const activeHref = findActiveNavItem(pathname)?.href;
  const currentLabel = findActiveNavItem(pathname)?.label ?? "Overview";

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar role={role} realCompanyCount={realCompanyCount} />

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex h-16 items-center justify-between border-b border-slate-200 px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
                  DL
                </div>
                <span className="text-sm font-semibold text-slate-900">DIRECTOR.LTD</span>
              </div>
              <button onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 hover:bg-slate-100">
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
              {NAV_ITEMS.filter((item) => !item.minRole || ROLE_RANK[role] >= ROLE_RANK[item.minRole]).map(
                (item) => {
                  const active = item.href === activeHref;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                        active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      <Icon className={cn("h-4 w-4", active ? "text-indigo-600" : "text-slate-400")} />
                      {item.label}
                    </Link>
                  );
                }
              )}
            </nav>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="text-sm font-semibold text-slate-900 sm:text-base">{currentLabel}</h1>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium text-slate-900">{userName}</div>
              <div className="text-xs text-slate-500">{role.replace("_", " ")}</div>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
              {userName.slice(0, 2).toUpperCase()}
            </div>
            <form action="/api/auth/logout" method="POST">
              <button
                title={`Sign out (${userEmail})`}
                className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
