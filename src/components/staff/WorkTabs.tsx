import Link from "next/link";
import { cn } from "@/lib/cn";
import { can } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/types";

const TABS = [
  { key: "work", href: "/work", label: "Assigned companies", permission: "work.assigned" },
  { key: "timesheets", href: "/work/timesheets", label: "My timesheets", permission: "timesheets.submit" },
] as const;

export function WorkTabs({ active, viewer }: { active: "work" | "timesheets"; viewer: { role: UserRole; permissions: readonly string[] } }) {
  const tabs = TABS.filter((t) => can(viewer, t.permission));
  return (
    <nav aria-label="My work sections" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={cn("shrink-0 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors focus-ring", active === t.key ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
