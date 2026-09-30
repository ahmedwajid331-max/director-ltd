import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hasRole } from "@/lib/auth/guard";

const bodySchema = z
  .object({
    active: z.boolean().optional(),
    role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
  })
  .strict();

// Authorization model (enforced here, never by hiding UI):
//  - SUPER_ADMIN may change any user, except they cannot deactivate/demote
//    themselves and the last active Super Admin can never be removed.
//  - ADMIN may only activate/deactivate accounts whose role is USER. An Admin
//    can never touch a Super Admin or another Admin, and can never change roles.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !hasRole(session, "ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true, active: true } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const actorIsSuper = session.role === "SUPER_ADMIN";

  if (!actorIsSuper) {
    if (target.role !== "USER") {
      return NextResponse.json({ error: "Only a Super Admin can modify Admin or Super Admin accounts." }, { status: 403 });
    }
    if (parsed.data.role !== undefined) {
      return NextResponse.json({ error: "Only a Super Admin can change roles." }, { status: 403 });
    }
  }

  const isSelf = id === session.userId;
  if (isSelf && (parsed.data.active === false || (parsed.data.role && parsed.data.role !== session.role))) {
    return NextResponse.json({ error: "You cannot deactivate or change the role of your own account." }, { status: 400 });
  }

  // Never allow the platform to end up with no active Super Admin.
  const losesSuper =
    target.role === "SUPER_ADMIN" &&
    target.active &&
    (parsed.data.active === false || (parsed.data.role !== undefined && parsed.data.role !== "SUPER_ADMIN"));
  if (losesSuper) {
    const otherSupers = await db.user.count({ where: { role: "SUPER_ADMIN", active: true, id: { not: id } } });
    if (otherSupers === 0) {
      return NextResponse.json({ error: "There must always be at least one active Super Admin." }, { status: 400 });
    }
  }

  const user = await db.user.update({
    where: { id },
    data: parsed.data,
    select: { id: true, email: true, name: true, role: true, active: true },
  });

  await db.activityLog.create({
    data: { userId: session.userId, action: "user_updated", meta: JSON.stringify({ targetId: id, ...parsed.data }) },
  });

  return NextResponse.json({ user });
}
