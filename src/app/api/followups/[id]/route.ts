import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { deleteFollowUpCalendarEvent } from "@/lib/calendar/sync-followup";

const bodySchema = z.object({ done: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const followUp = await db.followUp.findUnique({ where: { id } });
  if (!followUp || followUp.userId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await db.followUp.update({ where: { id }, data: { done: parsed.data.done } });
  if (followUp.done !== parsed.data.done) {
    const state = await db.userCompanyState.findUnique({ where: { id: followUp.userCompanyStateId }, select: { companyId: true } });
    if (state) {
      await logActivity(session, parsed.data.done ? "followup_done" : "followup_reopened", { companyId: state.companyId });
    }
  }
  return NextResponse.json({ followUp: updated });
}

// Removes ONE completed follow-up. Open (overdue / upcoming) follow-ups are never deletable here. The follow-up row is
// removed, but its history stays: earlier activity entries live in ActivityLog (no foreign key) and are untouched, and a
// "followup_deleted" entry is added. Notes, contacts and the company itself are not affected.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const followUp = await db.followUp.findUnique({ where: { id }, include: { userCompanyState: { select: { companyId: true } } } });
  if (!followUp || followUp.userId !== session.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!followUp.done) return NextResponse.json({ error: "Only completed follow-ups can be deleted." }, { status: 409 });

  await deleteFollowUpCalendarEvent(id, session.userId);
  const { count } = await db.followUp.deleteMany({ where: { id, userId: session.userId, done: true } });
  if (count > 0) await logActivity(session, "followup_deleted", { companyId: followUp.userCompanyState.companyId });
  return NextResponse.json({ ok: true, deleted: count });
}
