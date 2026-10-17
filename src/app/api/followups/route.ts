import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { can } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { deleteFollowUpCalendarEvent } from "@/lib/calendar/sync-followup";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "calendar.use");
  if (denied) return denied;

  const followUps = await db.followUp.findMany({
    where: { userId: session.userId },
    orderBy: { dueDate: "asc" },
    include: { userCompanyState: { include: { company: true } } },
  });

  // Assigned work that has a due date, for the signed-in user ONLY (the same rule as the My work page: the assignee, and only
  // while they may receive assigned work). Open ones, plus those completed in the last 90 days. Cancelled work is withdrawn,
  // and work without a due date has no place on a calendar (it stays on My work).
  const since = new Date(Date.now() - 90 * 86_400_000);
  const assignments = can(session, "work.assigned")
    ? await db.assignment.findMany({
        where: { assigneeId: session.userId, dueDate: { not: null }, OR: [{ status: "open" }, { status: "done", completedAt: { gte: since } }] },
        orderBy: { dueDate: "asc" },
        take: 500,
        include: { company: { select: { id: true, name: true } }, assignedBy: { select: { name: true } } },
      })
    : [];

  return NextResponse.json({
    followUps: followUps.map((f) => ({
      id: f.id,
      dueDate: f.dueDate,
      note: f.note,
      done: f.done,
      companyId: f.userCompanyState.company.id,
      companyName: f.userCompanyState.company.name,
    })),
    assignments: assignments.map((a) => ({
      id: a.id,
      dueDate: a.dueDate,
      note: a.note,
      done: a.status === "done",
      companyId: a.company.id,
      companyName: a.company.name,
      assignedBy: a.assignedBy.name,
    })),
  });
}

// "Clear completed": removes only the caller's own COMPLETED follow-ups. Open follow-ups, notes, contacts and companies are
// untouched; activity history is kept and one "followups_cleared" entry is added per affected company.
export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "calendar.use");
  if (denied) return denied;

  const done = await db.followUp.findMany({
    where: { userId: session.userId, done: true },
    select: { id: true, userCompanyState: { select: { companyId: true } } },
  });
  const ids = done.map((f) => f.id);
  for (const id of ids) await deleteFollowUpCalendarEvent(id, session.userId);
  const { count } = await db.followUp.deleteMany({ where: { id: { in: ids }, userId: session.userId, done: true } });
  for (const companyId of new Set(done.map((f) => f.userCompanyState.companyId))) {
    await logActivity(session, "followups_cleared", { companyId });
  }
  return NextResponse.json({ ok: true, deleted: count });
}
