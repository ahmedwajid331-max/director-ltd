import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { canResubmit } from "@/lib/staff/timesheet";
import { addDays, appTimezone, dayKey, isYmd } from "@/lib/staff/periods";

const MAX_BACKDATE_DAYS = 62;

const bodySchema = z.object({
  workDate: z.string().refine(isYmd, "Choose a real date."),
  minutes: z.number().int().min(1).max(24 * 60),
  note: z.string().trim().max(500).optional(),
});

// A staff member reports the hours they worked on one day. This is a CLAIM awaiting a supervisor: it is never approved
// automatically and never derived from login time. One timesheet per person per day; a rejected or returned one can be corrected
// and resubmitted; an approved one changes only through a reviewer's recorded amendment.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "timesheets.submit");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid date and a number of minutes between 1 and 1440." }, { status: 400 });
  const { workDate, minutes, note } = parsed.data;

  const today = dayKey(new Date(), appTimezone());
  if (workDate > today) return NextResponse.json({ error: "You cannot submit hours for a future day." }, { status: 400 });
  if (workDate < addDays(today, -MAX_BACKDATE_DAYS)) return NextResponse.json({ error: `Timesheets can be submitted for the last ${MAX_BACKDATE_DAYS} days only.` }, { status: 400 });

  const date = new Date(`${workDate}T00:00:00.000Z`);
  const existing = await db.timesheet.findUnique({ where: { userId_workDate: { userId: session.userId, workDate: date } } });
  if (existing && !canResubmit(existing.status)) return NextResponse.json({ error: "That day has already been approved and cannot be changed. Ask your supervisor to amend it." }, { status: 409 });
  if (existing?.status === "submitted" && existing.submittedMinutes === minutes && (existing.note ?? null) === (note || null)) {
    return NextResponse.json({ error: "That day is already submitted with the same hours and is waiting for approval." }, { status: 409 });
  }

  const data = { submittedMinutes: minutes, note: note || null, status: "submitted", approvedMinutes: null, reviewedById: null, reviewedAt: null, reviewNote: null, rateMinorAtApproval: null, rateCurrencyAtApproval: null };
  let timesheet;
  try {
    if (existing) {
      // Guarded on the status we read, so a sheet approved a moment ago is never overwritten by a late resubmission.
      const res = await db.timesheet.updateMany({ where: { id: existing.id, status: existing.status }, data });
      if (res.count !== 1) return NextResponse.json({ error: "That day was just changed by someone else. Reload and try again." }, { status: 409 });
      timesheet = await db.timesheet.findUniqueOrThrow({ where: { id: existing.id } });
    } else {
      timesheet = await db.timesheet.create({ data: { userId: session.userId, workDate: date, ...data } });
    }
  } catch (err) {
    // Two identical requests racing: the unique (user, day) key lets exactly one in.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return NextResponse.json({ error: "That day is already submitted." }, { status: 409 });
    throw err;
  }
  // The audit event keeps what the sheet looked like before this submission, so the history survives resubmission.
  await logActivity(session, "timesheet_submitted", {
    meta: { timesheetId: timesheet.id, workDate, minutes, ...(existing ? { resubmitted: true, previousStatus: existing.status, previousMinutes: existing.submittedMinutes, previousReviewNote: existing.reviewNote } : {}) },
  });
  return NextResponse.json({ timesheet });
}
