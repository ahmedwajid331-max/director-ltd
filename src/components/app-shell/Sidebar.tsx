"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { UserRole } from "@/lib/types";
import { NAV_ITEMS, findActiveNavItem } from "@/lib/nav";
import { cn } from "@/lib/cn";

const ROLE_RANK: Record<UserRole, number> = { USER: 0, ADMIN: 1, SUPER_ADMIN: 2 };

export function Sidebar({ role, hasRealData }: { role: UserRole; hasRealData: boolean }) {
  const pathname = usePathname();
  const activeHref = findActiveNavItem(pathname)?.href;

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
      <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
          DL
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-900">DIRECTOR.LTD</div>
          <div className="text-[11px] text-slate-500">Company Intelligence</div>
        </div>
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
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                )}
              >
                <Icon className={cn("h-4 w-4", active ? "text-indigo-600" : "text-slate-400")} />
                {item.label}
              </Link>
            );
          }
        )}
      </nav>

      <div className="border-t border-slate-200 p-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
          Companies House data:{" "}
          <span className="font-medium text-slate-700">
            {hasRealData ? "live data connected" : "development seed data"}
          </span>
        </div>
      </div>
    </aside>
  );
}
