import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { can } from "@/lib/auth/permissions";
import { resolvePermissions } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { findScopedUser } from "@/lib/staff/scope";
import type { UserRole } from "@/lib/types";

const bodySchema = z.object({
  companyId: z.string().min(1).max(64).optional(),
  // Alternative to companyId: the Companies House number staff actually know.
  companyNumber: z.string().trim().min(2).max(12).optional(),
  assigneeId: z.string().min(1).max(64),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().trim().max(500).optional(),
});

// Allocate a company to a staff member. Needs team.assign, and the assignee must be inside the caller's scope (a
// supervisor can only assign to their own team) and must be allowed to receive work. Companies are never copied: the
// assignment just points at the one shared Company record.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "team.assign");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose a company and a staff member." }, { status: 400 });
  const { assigneeId, dueDate, note } = parsed.data;
  if (!parsed.data.companyId && !parsed.data.companyNumber) return NextResponse.json({ error: "Enter a company number." }, { status: 400 });

  const assignee = await findScopedUser(session, assigneeId, "team.assign", { id: true, name: true, active: true, role: true, permissions: true });
  if (!assignee || !assignee.active) return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
  if (!can({ role: assignee.role as UserRole, permissions: resolvePermissions(assignee.role as UserRole, assignee.permissions) }, "work.assigned")) {
    return NextResponse.json({ error: `${assignee.name} is not set up to receive assigned work.` }, { status: 400 });
  }
  const company = await db.company.findUnique({
    where: parsed.data.companyId ? { id: parsed.data.companyId } : { companyNumber: parsed.data.companyNumber!.toUpperCase() },
    select: { id: true, name: true },
  });
  if (!company) return NextResponse.json({ error: "Company not found." }, { status: 404 });
  const companyId = company.id;

  const duplicate = await db.assignment.findFirst({ where: { companyId, assigneeId, status: "open" }, select: { id: true } });
  if (duplicate) return NextResponse.json({ error: "That company is already assigned to this person and still open." }, { status: 409 });

  const assignment = await db.assignment.create({
    data: { companyId, assigneeId, assignedById: session.userId, dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null, note: note || null },
  });
  await logActivity(session, "assignment_created", { meta: { assigneeId, assigneeName: assignee.name, companyName: company.name, dueDate: dueDate ?? null }, companyId });
  return NextResponse.json({ assignment });
}
