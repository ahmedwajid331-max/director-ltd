import { db } from "@/lib/db";
import { formatDateOnly } from "@/lib/data/format";

// "What have I already done with this company?" - the caller's OWN ActivityLog rows that mention this company.
// Only genuine CRM events are listed (searches, logins etc. never are), and the log is strictly filtered by userId,
// so one user's activity can never appear on another user's view of the same company.
export const CRM_ACTIONS = [
  "company_follow_toggle",
  "company_trash_toggle",
  "company_state_change",
  "note_added",
  "note_edited",
  "note_deleted",
  "director_contact_added",
  "contact_edited",
  "contact_deleted",
  "followup_created",
  "followup_done",
  "followup_reopened",
  "followup_deleted",
  "followups_cleared",
  "contact_logged",
] as const;

export type ActivityKind = "saved" | "flag" | "follow" | "trash" | "note" | "contact" | "followup" | "done";

export interface CompanyActivityItem {
  id: string;
  text: string;
  kind: ActivityKind;
  createdAt: string;
}

function describe(action: string, meta: Record<string, unknown>): { text: string; kind: ActivityKind } | null {
  switch (action) {
    case "company_follow_toggle":
      return { text: meta.followed ? "Company followed" : "Company unfollowed", kind: "follow" };
    case "company_trash_toggle":
      return { text: meta.trashed ? "Moved to trash" : "Restored from trash", kind: "trash" };
    case "company_state_change":
      if (meta.saved !== undefined) return { text: meta.saved ? "Company saved" : "Removed from saved", kind: "saved" };
      if (meta.redFlagged !== undefined) return { text: meta.redFlagged ? "Company red flagged" : "Red flag removed", kind: "flag" };
      return { text: "Company status changed", kind: "saved" };
    case "note_added":
      return { text: "Note added", kind: "note" };
    case "note_edited":
      return { text: "Note edited", kind: "note" };
    case "note_deleted":
      return { text: "Note deleted", kind: "note" };
    case "director_contact_added":
      return { text: meta.name ? `Contact added: ${String(meta.name)}` : "Contact added", kind: "contact" };
    case "contact_edited":
      return { text: meta.name ? `Contact updated: ${String(meta.name)}` : "Contact updated", kind: "contact" };
    case "contact_deleted":
      return { text: meta.name ? `Contact removed: ${String(meta.name)}` : "Contact removed", kind: "contact" };
    case "followup_created":
      return { text: meta.dueDate ? `Follow-up scheduled for ${formatDateOnly(String(meta.dueDate))}` : "Follow-up scheduled", kind: "followup" };
    case "followup_done":
      return { text: "Follow-up completed", kind: "done" };
    case "followup_reopened":
      return { text: "Follow-up reopened", kind: "followup" };
    case "followup_deleted":
      return { text: "Completed follow-up removed", kind: "followup" };
    case "followups_cleared":
      return { text: "Completed follow-ups cleared", kind: "followup" };
    case "contact_logged":
      return { text: "Contact recorded", kind: "contact" };
    default:
      return null;
  }
}

export async function getCompanyActivity(userId: string, companyId: string, take = 50): Promise<CompanyActivityItem[]> {
  const rows = await db.activityLog.findMany({
    where: { userId, companyId, action: { in: [...CRM_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take,
  });
  const items: CompanyActivityItem[] = [];
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try {
      meta = r.meta ? JSON.parse(r.meta) : {};
    } catch {
      /* ignore malformed meta */
    }
    const d = describe(r.action, meta);
    if (d) items.push({ id: r.id, ...d, createdAt: r.createdAt.toISOString() });
  }
  return items;
}
