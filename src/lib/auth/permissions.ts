import type { UserRole } from "@/lib/types";

// Granular permissions. The catalogue below is the single source of truth: the create/edit-user UI renders it, the
// server checks keys from it, and nothing is listed that is not enforced somewhere (see the "Enforced in" notes).
//
// Storage: User.permissions is a JSON array of keys, or NULL meaning "the role's default set" - so every account that
// existed before permissions were introduced keeps exactly the access it had. SUPER_ADMIN always has everything and
// can never be restricted (it is also the only role that may change permissions or system configuration).

export type PermissionGroup = "Company data" | "Reports" | "CRM and collaboration" | "Administration";

export interface PermissionDef {
  key: string;
  label: string;
  description: string;
  group: PermissionGroup;
}

export const PERMISSIONS = [
  // Company data
  { key: "companies.view", group: "Company data", label: "View and search companies", description: "Companies list, search box, company pages. Enforced in: search API, company pages, export." },
  { key: "companies.advancedSearch", group: "Company data", label: "Advanced Search and AND / OR filters", description: "The Advanced Search page and any filter using OR or nested groups (also in the Report Builder)." },
  { key: "companies.directors", group: "Company data", label: "View director information", description: "Officers and director details on company pages and the director refresh API." },
  { key: "crm.manage", group: "Company data", label: "Follow, save, flag and trash companies", description: "The Followed, Saved, Red flagged and Trash markers, including bulk changes." },

  // Reports
  { key: "reports.create", group: "Reports", label: "Create reports", description: "Report Builder and saving a new report." },
  { key: "reports.viewOwn", group: "Reports", label: "View their own reports", description: "Saved Reports list and report pages they own." },
  { key: "reports.edit", group: "Reports", label: "Edit and delete their own reports", description: "Changing a saved report's name, conditions, columns, daily refresh; deleting it; refreshing it." },
  { key: "reports.exportCsv", group: "Reports", label: "Export CSV", description: "CSV downloads of companies and reports." },
  { key: "reports.exportDocs", group: "Reports", label: "Download PDF and Word", description: "PDF and Word downloads of a saved report." },
  { key: "reports.share", group: "Reports", label: "Share reports", description: "The Share menu on a report (links are never public; recipients still need access)." },
  { key: "reports.viewOthers", group: "Reports", label: "View other users' reports", description: "Open any user's saved report, including its exports." },

  // CRM and collaboration
  { key: "crm.notes", group: "CRM and collaboration", label: "Notes, follow-ups and contact log", description: "Adding notes and follow-ups, managing contacts and recording contact outcomes." },
  { key: "calendar.use", group: "CRM and collaboration", label: "Calendar", description: "The Calendar page and calendar connections." },
  { key: "timesheets.submit", group: "CRM and collaboration", label: "Submit timesheets", description: "Report their own working hours for approval." },
  { key: "work.assigned", group: "CRM and collaboration", label: "Receive assigned work", description: "Be assigned companies to work on and see their own work queue." },

  // Administration (a supervisor sees only their own team)
  { key: "staff.view", group: "Administration", label: "View the staff directory", description: "Staff list and profiles for their own team." },
  { key: "staff.activity", group: "Administration", label: "View staff activity and monitoring reports", description: "Sessions, activity timeline and period reports for their own team." },
  { key: "staff.manage", group: "Administration", label: "Manage staff accounts", description: "Create user accounts and activate / deactivate users in their team." },
  { key: "team.assign", group: "Administration", label: "Assign work to staff", description: "Allocate companies to members of their team and review their queues." },
  { key: "timesheets.approve", group: "Administration", label: "Approve timesheets", description: "Review, adjust and approve or reject their team's timesheets." },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);
export const PERMISSION_GROUPS: PermissionGroup[] = ["Company data", "Reports", "CRM and collaboration", "Administration"];
const KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);

const ADMIN_ONLY: PermissionKey[] = ["staff.view", "staff.activity", "staff.manage", "team.assign", "timesheets.approve"];

// What a USER could do before permissions existed (unchanged behaviour for existing accounts).
export const LEGACY_USER_PERMISSIONS: PermissionKey[] = ALL_PERMISSION_KEYS.filter((k) => !ADMIN_ONLY.includes(k) && k !== "reports.viewOthers");

// What an ADMIN could do before: everything a user can, see all reports, manage users.
export const LEGACY_ADMIN_PERMISSIONS: PermissionKey[] = ALL_PERMISSION_KEYS;

// Least privilege preset for a NEWLY created account (Super Admin can tick more). No exports, sharing, director data,
// Advanced Search or other people's reports unless explicitly granted.
export const NEW_ACCOUNT_DEFAULT: PermissionKey[] = [
  "companies.view",
  "crm.manage",
  "crm.notes",
  "calendar.use",
  "reports.create",
  "reports.viewOwn",
  "reports.edit",
  "timesheets.submit",
  "work.assigned",
];

export function isPermissionKey(k: unknown): k is PermissionKey {
  return typeof k === "string" && KEY_SET.has(k);
}

export function parsePermissions(json: string | null | undefined): PermissionKey[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter(isPermissionKey) : null;
  } catch {
    return null;
  }
}

// Implications: you cannot meaningfully edit/export/share a report you cannot view, nor open Advanced Search without
// being able to search.
const IMPLIES: Partial<Record<PermissionKey, PermissionKey[]>> = {
  "reports.create": ["reports.viewOwn"],
  "reports.edit": ["reports.viewOwn"],
  "reports.exportCsv": ["reports.viewOwn"],
  "reports.exportDocs": ["reports.viewOwn"],
  "reports.share": ["reports.viewOwn"],
  "reports.viewOthers": ["reports.viewOwn"],
  "companies.advancedSearch": ["companies.view"],
  "companies.directors": ["companies.view"],
  "crm.manage": ["companies.view"],
  "crm.notes": ["companies.view"],
};

export function withImplied(keys: Iterable<PermissionKey>): PermissionKey[] {
  const out = new Set<PermissionKey>(keys);
  for (const k of [...out]) for (const i of IMPLIES[k] ?? []) out.add(i);
  return ALL_PERMISSION_KEYS.filter((k) => out.has(k));
}

export function resolvePermissions(role: UserRole, stored: string | null | undefined): PermissionKey[] {
  if (role === "SUPER_ADMIN") return [...ALL_PERMISSION_KEYS];
  const explicit = parsePermissions(stored);
  if (explicit) return withImplied(explicit);
  return role === "ADMIN" ? [...LEGACY_ADMIN_PERMISSIONS] : [...LEGACY_USER_PERMISSIONS];
}

export interface HasPermissions {
  role: UserRole;
  permissions: readonly string[];
}

export function can(subject: HasPermissions | null | undefined, key: PermissionKey): boolean {
  if (!subject) return false;
  if (subject.role === "SUPER_ADMIN") return true;
  return subject.permissions.includes(key);
}

export type PermissionListResult = { ok: true; keys: PermissionKey[] } | { ok: false; error: string };

// Validates an untrusted list from the API: only known keys, no duplicates, administration keys only for ADMIN accounts.
export function validatePermissionList(input: unknown, role: UserRole): PermissionListResult {
  if (!Array.isArray(input)) return { ok: false, error: "Permissions must be a list." };
  const keys: PermissionKey[] = [];
  for (const k of input) {
    if (!isPermissionKey(k)) return { ok: false, error: `Unknown permission "${String(k).slice(0, 40)}".` };
    if (!keys.includes(k)) keys.push(k);
  }
  if (role === "USER" && keys.some((k) => ADMIN_ONLY.includes(k))) {
    return { ok: false, error: "Administration permissions can only be given to Admin accounts." };
  }
  return { ok: true, keys: withImplied(keys) };
}

export const ADMIN_ONLY_KEYS = ADMIN_ONLY;
