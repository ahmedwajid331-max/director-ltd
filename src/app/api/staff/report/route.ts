import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { csvLine } from "@/lib/data/csv";
import { resolvePeriod } from "@/lib/staff/periods";
import { MAX_PEOPLE, loadStaffReport } from "@/lib/staff/report";
import { formatDuration } from "@/lib/staff/sessions";
import { presenceLabel } from "@/lib/staff/stats";

// CSV of the Activity & reports table for a period. Same loader and scope as the page; needs staff.activity.
export async function GET(request: Request) {
  const session = await getSession();
  const denied = denyUnless(session, "staff.activity");
  if (denied || !session) return denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const r = resolvePeriod({ kind: sp.get("period") ?? "week", anchor: sp.get("anchor") || undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  const role = sp.get("role");
  const report = await loadStaffReport(session, r.period, {
    staffId: sp.get("staff") || undefined,
    role: role === "USER" || role === "ADMIN" || role === "SUPER_ADMIN" ? role : undefined,
    teamId: sp.get("team") || undefined,
  });
  // A CSV must be the whole list or nothing: never a silently shortened file.
  if (report.truncated) {
    return NextResponse.json({ error: `This report covers more than ${MAX_PEOPLE.toLocaleString()} people. Narrow it by team or role and download again.` }, { status: 413 });
  }

  const lines = [
    csvLine(["Staff member", "Email", "Role", "Account", "Session state now", "Sessions", "Recorded session time", "Recorded actions", "Searches", "Companies worked", "Contacts logged", "Contacts that reached a person", "Follow-ups created", "Follow-ups completed", "Reports created", "Exports", "Assigned work completed", "Failed sign-ins", "Period", "Timezone"]),
    ...report.rows.map((x) =>
      csvLine([
        x.user.name, x.user.email, x.user.role, x.user.active ? "Active" : "Inactive",
        presenceLabel(x.presence.status),
        x.stats.sessions, formatDuration(x.stats.sessionMs), x.stats.meaningfulActions, x.stats.searches, x.stats.companiesWorked, x.stats.contactsLogged, x.stats.contactsReached,
        x.stats.followUpsCreated, x.stats.followUpsDone, x.stats.reportsCreated, x.stats.exports, x.stats.assignmentsCompleted, x.stats.failedLogins, r.period.label, r.period.tz,
      ])
    ),
  ];
  await logActivity(session, "staff_report_exported", { meta: { period: r.period.kind, from: r.period.fromDay, to: r.period.toDay, rows: report.rows.length } });
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="staff-activity-${r.period.fromDay}_${r.period.toDay}.csv"`, "Cache-Control": "no-store" },
  });
}
