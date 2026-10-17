import type { UserRole } from "@/lib/types";
import { can, type PermissionKey } from "@/lib/auth/permissions";
import {
  LayoutDashboard,
  Building2,
  FileSearch,
  ListFilter,
  BookMarked,
  Star,
  Bookmark,
  Flag,
  Trash2,
  CalendarDays,
  Users,
  ShieldCheck,
  Settings,
  Briefcase,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  minRole?: UserRole;
  // Shown only to someone holding at least one of these permissions (the pages and APIs enforce them regardless).
  anyPermission?: PermissionKey[];
  // Hidden for this role (a Super Admin reaches the same pages through the Super Admin tabs).
  hideForRole?: UserRole;
  // Rendered at the right-hand end of the header nav (account / administration).
  secondary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/companies", label: "UK Companies", icon: Building2, anyPermission: ["companies.view"] },
  { href: "/companies/advanced", label: "Advanced Search", icon: ListFilter, anyPermission: ["companies.advancedSearch"] },
  { href: "/reports/new", label: "Report Builder", icon: FileSearch, anyPermission: ["reports.create"] },
  { href: "/reports", label: "Saved Reports", icon: BookMarked, anyPermission: ["reports.viewOwn"] },
  { href: "/watches", label: "Watches", icon: Star, anyPermission: ["crm.manage"] },
  { href: "/saved", label: "Saved", icon: Bookmark, anyPermission: ["crm.manage"] },
  { href: "/red-flags", label: "Red flags", icon: Flag, anyPermission: ["crm.manage"] },
  { href: "/calendar", label: "Calendar", icon: CalendarDays, anyPermission: ["calendar.use"] },
  { href: "/work", label: "My work", icon: Briefcase, anyPermission: ["work.assigned", "timesheets.submit"] },
  { href: "/trash", label: "Trash", icon: Trash2, anyPermission: ["crm.manage"] },
  { href: "/users", label: "Users", icon: Users, minRole: "ADMIN", anyPermission: ["staff.manage"], secondary: true },
  { href: "/admin/staff", label: "Team", icon: UsersRound, minRole: "ADMIN", hideForRole: "SUPER_ADMIN", anyPermission: ["staff.view", "staff.activity", "timesheets.approve"], secondary: true },
  { href: "/admin", label: "Super Admin", icon: ShieldCheck, minRole: "SUPER_ADMIN", secondary: true },
  { href: "/settings", label: "Settings", icon: Settings, secondary: true },
];

// Several nav items share a route prefix (e.g. /reports and /reports/new),
// so highlighting "every item whose href prefixes the pathname" would light
// up more than one at once. Only the most specific (longest href) match
// should be treated as active.
export function visibleNavItems(viewer: { role: UserRole; permissions: readonly string[] }, rank: Record<UserRole, number>): NavItem[] {
  return NAV_ITEMS.filter(
    (i) =>
      (!i.minRole || rank[viewer.role] >= rank[i.minRole]) &&
      i.hideForRole !== viewer.role &&
      (!i.anyPermission || i.anyPermission.some((p) => can(viewer, p)))
  );
}

export function findActiveNavItem(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  const matches = items.filter(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );
  return matches.sort((a, b) => b.href.length - a.href.length)[0];
}
