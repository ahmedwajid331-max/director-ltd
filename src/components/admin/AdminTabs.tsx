import Link from "next/link";
import { cn } from "@/lib/cn";
import { can, type PermissionKey } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/types";

// Section bar at the top of the Super Admin / team-management area. Overview and Column settings are the original
// Super Admin tabs, unchanged; Staff, Activity & reports and Timesheets appear for anyone holding the matching
// permission (a supervisor sees only the tabs they may use, and only their own team's data inside them).
const TABS: { key: string; href: string; label: string; superOnly?: boolean; permission?: PermissionKey }[] = [
  { key: "overview", href: "/admin", label: "Overview", superOnly: true },
  { key: "staff", href: "/admin/staff", label: "Staff", permission: "staff.view" },
  { key: "activity", href: "/admin/activity", label: "Activity & reports", permission: "staff.activity" },
  { key: "timesheets", href: "/admin/timesheets", label: "Timesheets", permission: "timesheets.approve" },
  { key: "columns", href: "/admin/columns", label: "Column & Default Settings", superOnly: true },
];

export type AdminTabKey = "overview" | "staff" | "activity" | "timesheets" | "columns";

export function AdminTabs({ active, viewer }: { active: AdminTabKey; viewer?: { role: UserRole; permissions: readonly string[] } }) {
  // Existing callers are Super Admin-only pages and pass no viewer.
  const v = viewer ?? { role: "SUPER_ADMIN" as UserRole, permissions: [] };
  const tabs = TABS.filter((t) => (t.superOnly ? v.role === "SUPER_ADMIN" : t.permission ? can(v, t.permission) : true));
  return (
    <nav aria-label="Super Admin sections" className="flex gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={cn(
            "shrink-0 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors focus-ring",
            active === t.key ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
