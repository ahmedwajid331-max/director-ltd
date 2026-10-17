// One catalogue of recorded event types: how each reads in a feed, and which category it filters under.
// Used by the Super Admin feed, the staff profile timeline, the monitoring reports and the CSV export so they agree.

export type ActionCategory = "security" | "companies" | "crm" | "reports" | "exports" | "work" | "admin";

export const CATEGORY_LABEL: Record<ActionCategory, string> = {
  security: "Sign-in & security",
  companies: "Company research",
  crm: "CRM",
  reports: "Reports",
  exports: "Exports & sharing",
  work: "Assigned work & time",
  admin: "Administration",
};

export const ACTION_CATEGORY_KEYS = Object.keys(CATEGORY_LABEL) as ActionCategory[];

type Meta = Record<string, unknown>;
const s = (v: unknown, fallback = "") => (typeof v === "string" && v ? v : fallback);

interface ActionDef {
  category: ActionCategory;
  describe: (m: Meta) => string;
  // Counts toward "meaningful work" totals (a sign-in or a settings change does not).
  meaningful?: boolean;
}

const ACTIONS: Record<string, ActionDef> = {
  login: { category: "security", describe: () => "Signed in" },
  logout: { category: "security", describe: () => "Signed out" },
  login_failed: { category: "security", describe: (m) => `Failed sign-in attempt${m.reason === "inactive" ? " (account deactivated)" : ""}` },

  search: {
    category: "companies",
    meaningful: true,
    describe: (m) => `Searched${m.q ? ` "${s(m.q)}"` : ""}${m.activeRules ? ` with ${m.activeRules} filter${Number(m.activeRules) > 1 ? "s" : ""}` : ""} (${m.total ?? "?"} results)`,
  },
  company_viewed: { category: "companies", meaningful: true, describe: (m) => `Opened ${s(m.companyName, "a company")}` },
  director_contact_added: { category: "crm", meaningful: true, describe: (m) => `Added contact "${s(m.name)}"` },

  company_follow_toggle: { category: "crm", meaningful: true, describe: (m) => `${m.followed ? "Followed" : "Unfollowed"} ${s(m.companyName, "a company")}` },
  company_trash_toggle: { category: "crm", meaningful: true, describe: (m) => `${m.trashed ? "Sent to trash" : "Restored"} ${s(m.companyName, "a company")}` },
  company_state_change: {
    category: "crm",
    meaningful: true,
    describe: (m) => {
      const changes = (["saved", "followed", "trashed", "redFlagged"] as const)
        .filter((k) => m[k] !== undefined)
        .map((k) => `${m[k] ? "set" : "cleared"} ${k === "redFlagged" ? "red flag" : k}`);
      return `${s(m.companyName, `${m.count ?? "?"} companies`)}: ${changes.join(", ")}`;
    },
  },
  note_added: { category: "crm", meaningful: true, describe: () => "Added a note" },
  note_edited: { category: "crm", describe: () => "Edited a note" },
  note_deleted: { category: "crm", describe: () => "Deleted a note" },
  followup_created: { category: "crm", meaningful: true, describe: (m) => `Created a follow-up${m.dueDate ? ` due ${s(m.dueDate)}` : ""}` },
  followup_done: { category: "crm", meaningful: true, describe: () => "Completed a follow-up" },
  followup_reopened: { category: "crm", describe: () => "Re-opened a follow-up" },
  contact_edited: { category: "crm", describe: (m) => `Edited contact "${s(m.name)}"` },
  contact_deleted: { category: "crm", describe: (m) => `Deleted contact "${s(m.name)}"` },
  contact_logged: { category: "crm", meaningful: true, describe: (m) => `Logged a ${s(m.channel, "contact")} (${s(m.outcome).replace(/_/g, " ")})` },

  report_created: { category: "reports", meaningful: true, describe: (m) => `Created report "${s(m.name)}"` },
  report_updated: { category: "reports", meaningful: true, describe: (m) => `Edited report "${s(m.name)}"` },
  report_deleted: { category: "reports", describe: (m) => `Deleted report "${s(m.name)}"` },
  report_refreshed: { category: "reports", describe: (m) => `Refreshed report "${s(m.name)}"` },
  report_viewed: { category: "reports", describe: (m) => `Viewed report "${s(m.name)}"` },
  report_shared: { category: "exports", describe: (m) => `Shared report "${s(m.name)}" (${s(m.method, "link")})` },

  export_csv: { category: "exports", meaningful: true, describe: (m) => `Exported ${m.rows ?? "?"} companies to CSV` },
  export_pdf: { category: "exports", meaningful: true, describe: (m) => `Downloaded a PDF report (${m.rows ?? "?"} companies)` },
  export_docx: { category: "exports", meaningful: true, describe: (m) => `Downloaded a Word report (${m.rows ?? "?"} companies)` },

  assignment_created: { category: "work", describe: (m) => `Assigned ${s(m.companyName, "a company")} to ${s(m.assigneeName, "a colleague")}` },
  assignment_reassigned: { category: "work", describe: (m) => `Reassigned ${s(m.companyName, "a company")} to ${s(m.assigneeName, "a colleague")}` },
  assignment_completed: { category: "work", meaningful: true, describe: (m) => `Completed assigned work: ${s(m.companyName, "a company")}` },
  assignment_cancelled: { category: "work", describe: (m) => `Cancelled assignment: ${s(m.companyName, "a company")}` },
  timesheet_submitted: { category: "work", describe: (m) => `${m.resubmitted ? "Resubmitted" : "Submitted"} a timesheet for ${s(m.workDate)} (${m.minutes ?? "?"} min)` },
  timesheet_approved: { category: "admin", describe: (m) => `Approved a timesheet (${m.approvedMinutes ?? "?"} min)` },
  timesheet_rejected: { category: "admin", describe: () => "Rejected a timesheet" },
  timesheet_returned: { category: "admin", describe: () => "Returned a timesheet for correction" },
  timesheet_amended: { category: "admin", describe: (m) => `Amended an approved timesheet (${m.fromMinutes ?? "?"} -> ${m.toMinutes ?? "?"} min)` },

  user_created: { category: "admin", describe: (m) => `Created a ${s(m.role, "USER").replace("_", " ").toLowerCase()} account` },
  user_updated: { category: "admin", describe: (m) => `Changed a user account${Array.isArray(m.changed) && m.changed.length ? ` (${m.changed.join(", ")})` : ""}` },
  permissions_changed: { category: "admin", describe: (m) => `Changed permissions (${m.granted ?? 0} granted, ${m.revoked ?? 0} revoked)` },
  staff_report_exported: { category: "admin", describe: (m) => `Exported a staff activity report (${m.rows ?? "?"} people, ${s(m.from)} to ${s(m.to)})` },
  session_ended_by_admin: { category: "admin", describe: () => "Ended a session" },
  profile_picture_changed: { category: "admin", describe: (m) => (m.action === "removed" ? "Removed their profile picture" : "Changed their profile picture") },
  column_settings_changed: { category: "admin", describe: (m) => `Changed column settings (${s(m.what, "settings").replace(/_/g, " ")})` },
  officer_retry_parked: { category: "admin", describe: () => "Re-queued parked officer fetches" },
  ch_breaker_reset: { category: "admin", describe: () => "Reset a Companies House circuit breaker" },
  officer_fetch_queued: { category: "companies", describe: () => "Queued an officer fetch" },
};

export function actionCategory(action: string): ActionCategory {
  return ACTIONS[action]?.category ?? "admin";
}

export function isMeaningful(action: string): boolean {
  return !!ACTIONS[action]?.meaningful;
}

export const MEANINGFUL_ACTIONS = Object.entries(ACTIONS)
  .filter(([, d]) => d.meaningful)
  .map(([k]) => k);
export const ALL_ACTIONS = Object.keys(ACTIONS);

export function actionsInCategory(c: ActionCategory): string[] {
  return Object.entries(ACTIONS)
    .filter(([, d]) => d.category === c)
    .map(([k]) => k);
}

export function describeAction(action: string, meta: string | null): string {
  let data: Meta = {};
  try {
    data = meta ? (JSON.parse(meta) as Meta) : {};
  } catch {
    /* unreadable meta: fall back to the bare action name */
  }
  const def = ACTIONS[action];
  return def ? def.describe(data) : action.replace(/_/g, " ");
}
