import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { syncFollowUpToCalendar } from "@/lib/calendar/sync-followup";
import { isRealIsoDate } from "@/lib/filters/validate";

// Follow-ups are date-only (no time of day): exactly YYYY-MM-DD, a real
// calendar date. Stored as a SQL DATE, so it means the same day everywhere.
const bodySchema = z.object({
  dueDate: z.string().refine(isRealIsoDate, { message: "dueDate must be a real date (YYYY-MM-DD)" }),
  note: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose a valid due date." }, { status: 400 });

  const company = await db.company.findUnique({ where: { id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const state = await db.userCompanyState.upsert({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    create: { userId: session.userId, companyId: id },
    update: {},
  });
  const followUp = await db.followUp.create({
    data: {
      userCompanyStateId: state.id,
      userId: session.userId,
      dueDate: new Date(`${parsed.data.dueDate}T00:00:00.000Z`),
      note: parsed.data.note || null,
    },
  });

  // Best-effort calendar sync - the follow-up above is already saved
  // regardless of whether this succeeds.
  await syncFollowUpToCalendar(followUp.id, session.userId);

  await logActivity(session, "followup_created", { meta: { dueDate: parsed.data.dueDate }, companyId: id });

  return NextResponse.json({ followUp });
}
