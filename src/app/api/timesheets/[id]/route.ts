import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { findScopedUser } from "@/lib/staff/scope";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), approvedMinutes: z.number().int().min(0).max(24 * 60).optional(), reviewNote: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("reject"), reviewNote: z.string().trim().min(1, "Say why.").max(500) }),
  z.object({ action: z.literal("return"), reviewNote: z.string().trim().min(1, "Say what needs correcting.").max(500) }),
  z.object({ action: z.literal("amend"), approvedMinutes: z.number().int().min(0).max(24 * 60), reviewNote: z.string().trim().min(1, "Say why it is being amended.").max(500) }),
]);

// Supervisor review: approve, reject, return for correction, or (on an approved day) amend with a reason. Needs timesheets.approve and the owner must be inside the reviewer's scope; nobody reviews their own
// timesheet (not even a Super Admin). Approved minutes can be lowered but never raised above what was claimed. The pay
// rate is captured at approval so later rate changes never rewrite history.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "timesheets.approve");
  if (denied) return denied;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });

  const sheet = await db.timesheet.findUnique({ where: { id } });
  const owner = sheet ? await findScopedUser(session, sheet.userId, "timesheets.approve", { id: true, hourlyRateMinor: true, rateCurrency: true }) : null;
  if (!sheet || !owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (sheet.userId === session.userId) return NextResponse.json({ error: "You cannot review your own timesheet." }, { status: 403 });
  const now = new Date();
  const conflict = () => NextResponse.json({ error: "This timesheet was just changed by someone else. Reload and check it." }, { status: 409 });

  // Amending an approved day: the original rate stays (it is what applied when the work was approved), the reason is
  // mandatory, and the audit event keeps the before/after so the original decision is never lost.
  if (parsed.data.action === "amend") {
    if (sheet.status !== "approved") return NextResponse.json({ error: "Only an approved timesheet can be amended." }, { status: 409 });
    if (parsed.data.approvedMinutes > sheet.submittedMinutes) return NextResponse.json({ error: "Approved time cannot exceed the time the person submitted." }, { status: 400 });
    // A day approved before any rate existed was never priced; amending it prices it at the rate now in force. A day that
    // already has a captured rate keeps it.
    const firstPricing = sheet.rateMinorAtApproval === null && owner.hourlyRateMinor !== null ? { rateMinorAtApproval: owner.hourlyRateMinor, rateCurrencyAtApproval: owner.rateCurrency } : {};
    const res = await db.timesheet.updateMany({ where: { id, status: "approved", approvedMinutes: sheet.approvedMinutes }, data: { approvedMinutes: parsed.data.approvedMinutes, reviewedById: session.userId, reviewedAt: now, reviewNote: parsed.data.reviewNote, ...firstPricing } });
    if (res.count !== 1) return conflict();
    await logActivity(session, "timesheet_amended", {
      meta: { timesheetId: id, userId: sheet.userId, fromMinutes: sheet.approvedMinutes, toMinutes: parsed.data.approvedMinutes, previousReviewerId: sheet.reviewedById, previousReviewedAt: sheet.reviewedAt?.toISOString(), previousNote: sheet.reviewNote, reason: parsed.data.reviewNote },
    });
    return NextResponse.json({ timesheet: await db.timesheet.findUniqueOrThrow({ where: { id } }) });
  }

  if (sheet.status !== "submitted") return NextResponse.json({ error: "This timesheet has already been reviewed." }, { status: 409 });

  if (parsed.data.action === "reject" || parsed.data.action === "return") {
    const status = parsed.data.action === "reject" ? "rejected" : "returned";
    const res = await db.timesheet.updateMany({ where: { id, status: "submitted" }, data: { status, reviewedById: session.userId, reviewedAt: now, reviewNote: parsed.data.reviewNote } });
    if (res.count !== 1) return conflict();
    await logActivity(session, status === "rejected" ? "timesheet_rejected" : "timesheet_returned", { meta: { timesheetId: id, userId: sheet.userId, submittedMinutes: sheet.submittedMinutes, reason: parsed.data.reviewNote } });
    return NextResponse.json({ timesheet: await db.timesheet.findUniqueOrThrow({ where: { id } }) });
  }

  const approvedMinutes = parsed.data.approvedMinutes ?? sheet.submittedMinutes;
  if (approvedMinutes > sheet.submittedMinutes) return NextResponse.json({ error: "Approved time cannot exceed the time the person submitted." }, { status: 400 });
  const res = await db.timesheet.updateMany({
    where: { id, status: "submitted" },
    data: {
      status: "approved",
      approvedMinutes,
      reviewedById: session.userId,
      reviewedAt: now,
      reviewNote: parsed.data.reviewNote || null,
      rateMinorAtApproval: owner.hourlyRateMinor,
      rateCurrencyAtApproval: owner.hourlyRateMinor === null ? null : owner.rateCurrency,
    },
  });
  if (res.count !== 1) return conflict();
  await logActivity(session, "timesheet_approved", { meta: { timesheetId: id, userId: sheet.userId, approvedMinutes, submittedMinutes: sheet.submittedMinutes, rateMinor: owner.hourlyRateMinor, currency: owner.rateCurrency } });
  return NextResponse.json({ timesheet: await db.timesheet.findUniqueOrThrow({ where: { id } }) });
}
