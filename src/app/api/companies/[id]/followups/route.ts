import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { syncFollowUpToCalendar } from "@/lib/calendar/sync-followup";

const bodySchema = z.object({
  dueDate: z.string().min(1),
  note: z.string().max(2000).optional(),
});

async function ensureState(userId: string, companyId: string) {
  return db.userCompanyState.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId },
    update: {},
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "A due date is required." }, { status: 400 });

  const state = await ensureState(session.userId, id);
  const followUp = await db.followUp.create({
    data: {
      userCompanyStateId: state.id,
      userId: session.userId,
      dueDate: new Date(parsed.data.dueDate),
      note: parsed.data.note || null,
    },
  });

  // Best-effort calendar sync — the follow-up above is already saved
  // regardless of whether this succeeds.
  await syncFollowUpToCalendar(followUp.id, session.userId);

  return NextResponse.json({ followUp });
}
