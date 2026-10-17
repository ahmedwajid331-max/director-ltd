import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { can, resolvePermissions } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { findScopedUser, userScopeWhere } from "@/lib/staff/scope";
import type { UserRole } from "@/lib/types";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("reassign"), assigneeId: z.string().min(1).max(64) }),
]);

// complete  - the assignee (or a supervisor who can manage that assignee) marks it done
// cancel    - a supervisor who can manage the assignee withdraws it
// reassign  - a supervisor moves it to another member of their scope
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const a = await db.assignment.findUnique({ where: { id }, include: { company: { select: { name: true } }, assignee: { select: { name: true } } } });
  const isAssignee = a?.assigneeId === session.userId;
  const inScope = a ? !!(await db.user.findFirst({ where: { AND: [{ id: a.assigneeId }, userScopeWhere(session)] }, select: { id: true } })) : false;
  const supervisor = inScope && can(session, "team.assign");
  // Out-of-scope assignments are reported as not found.
  if (!a || (!isAssignee && !supervisor)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (a.status !== "open") return NextResponse.json({ error: "This assignment is already closed." }, { status: 409 });

  const meta = { companyName: a.company.name, assigneeName: a.assignee.name };
  if (parsed.data.action === "complete") {
    const updated = await db.assignment.update({ where: { id }, data: { status: "done", completedAt: new Date() } });
    await logActivity(session, "assignment_completed", { meta, companyId: a.companyId });
    return NextResponse.json({ assignment: updated });
  }
  if (!supervisor) return NextResponse.json({ error: "You do not have permission to do that.", permission: "team.assign" }, { status: 403 });

  if (parsed.data.action === "cancel") {
    const updated = await db.assignment.update({ where: { id }, data: { status: "cancelled", completedAt: new Date() } });
    await logActivity(session, "assignment_cancelled", { meta, companyId: a.companyId });
    return NextResponse.json({ assignment: updated });
  }

  const target = await findScopedUser(session, parsed.data.assigneeId, "team.assign", { id: true, name: true, active: true, role: true, permissions: true });
  if (!target || !target.active) return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
  if (!can({ role: target.role as UserRole, permissions: resolvePermissions(target.role as UserRole, target.permissions) }, "work.assigned")) {
    return NextResponse.json({ error: `${target.name} is not set up to receive assigned work.` }, { status: 400 });
  }
  const updated = await db.assignment.update({ where: { id }, data: { assigneeId: target.id } });
  await logActivity(session, "assignment_reassigned", { meta: { companyName: a.company.name, assigneeName: target.name, fromName: a.assignee.name }, companyId: a.companyId });
  return NextResponse.json({ assignment: updated });
}
