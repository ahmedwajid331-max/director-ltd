import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { findScopedUser } from "@/lib/staff/scope";

// Signs a staff member out of every open session (their cookies stop working at once). The end time recorded is the
// moment an administrator did this, with the reason "admin_ended" - not a guess about when they stopped working.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = denyUnless(session, "staff.manage");
  if (denied || !session) return denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const target = await findScopedUser(session, id, "staff.manage", { id: true, role: true });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (target.role !== "USER" && session.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Only a Super Admin can end an Admin's sessions." }, { status: 403 });

  const res = await db.userSession.updateMany({ where: { userId: id, endedAt: null }, data: { endedAt: new Date(), endReason: "admin_ended" } });
  await logActivity(session, "session_ended_by_admin", { meta: { targetId: id, sessions: res.count } });
  return NextResponse.json({ ended: res.count });
}
