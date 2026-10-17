import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { CRM_ACTIONS } from "@/lib/data/company-activity";

// Removes ONE of the signed-in user's own activity entries for this company. Only the log row is deleted.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id, entryId } = await params;
  const { count } = await db.activityLog.deleteMany({ where: { id: entryId, userId: session.userId, companyId: id, action: { in: [...CRM_ACTIONS] } } });
  if (count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: count });
}
