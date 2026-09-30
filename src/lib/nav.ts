import type { UserRole } from "@/lib/types";
import {
  LayoutDashboard,
  Building2,
  FileSearch,
  BookMarked,
  Star,
  Trash2,
  CalendarDays,
  Users,
  ShieldCheck,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  minRole?: UserRole;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/reports/new", label: "Report Builder", icon: FileSearch },
  { href: "/reports", label: "Saved Reports", icon: BookMarked },
  { href: "/watches", label: "Watches", icon: Star },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/users", label: "Users", icon: Users, minRole: "ADMIN" },
  { href: "/admin", label: "Super Admin", icon: ShieldCheck, minRole: "SUPER_ADMIN" },
  { href: "/settings", label: "Settings", icon: Settings },
];

// Several nav items share a route prefix (e.g. /reports and /reports/new),
// so highlighting "every item whose href prefixes the pathname" would light
// up more than one at once. Only the most specific (longest href) match
// should be treated as active.
export function findActiveNavItem(pathname: string): NavItem | undefined {
  const matches = NAV_ITEMS.filter(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );
  return matches.sort((a, b) => b.href.length - a.href.length)[0];
}
