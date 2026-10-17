import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { CRM_ACTIONS } from "@/lib/data/company-activity";

// "Clear all activities": removes only the signed-in user's own CRM activity entries for THIS company (the same rows the
// Activity tab lists). Other users', other companies' and non-CRM entries are never matched, and no CRM data (notes,
// contacts, follow-ups, state) is touched - the underlying actions stay exactly as they were.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const { count } = await db.activityLog.deleteMany({ where: { userId: session.userId, companyId: id, action: { in: [...CRM_ACTIONS] } } });
  return NextResponse.json({ ok: true, deleted: count });
}
