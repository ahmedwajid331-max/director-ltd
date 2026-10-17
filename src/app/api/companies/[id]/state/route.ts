import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { resolveStatePatch, statePatchSchema } from "@/lib/data/company-state";

// Follow/Trash exclusivity lives in resolveStatePatch; Saved and Red Flag are independent.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.manage");
  if (denied) return denied;

  const { id } = await params;
  const parsed = statePatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const company = await db.company.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const next = resolveStatePatch(parsed.data);

  const state = await db.userCompanyState.upsert({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    create: { userId: session.userId, companyId: id, ...next },
    update: next,
  });

  await logActivity(
    session,
    parsed.data.followed !== undefined ? "company_follow_toggle" : parsed.data.trashed !== undefined ? "company_trash_toggle" : "company_state_change",
    { meta: { companyName: company.name, ...parsed.data }, companyId: id }
  );

  return NextResponse.json({ state });
}
