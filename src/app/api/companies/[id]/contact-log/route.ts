import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { CONTACT_CHANNELS, CONTACT_OUTCOMES } from "@/lib/staff/contact";

const bodySchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  outcome: z.enum(CONTACT_OUTCOMES),
  note: z.string().trim().max(500).optional(),
});

// Records that the signed-in user actually contacted (or tried to contact) someone about this company. This is the ONLY
// thing that counts as "contacted" in staff reports: opening, searching or following a company never does.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose how you made contact and what happened." }, { status: 400 });

  const company = await db.company.findUnique({ where: { id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const entry = await db.contactLog.create({
    data: { userId: session.userId, companyId: id, channel: parsed.data.channel, outcome: parsed.data.outcome, note: parsed.data.note || null },
    select: { id: true, channel: true, outcome: true, note: true, createdAt: true },
  });
  await logActivity(session, "contact_logged", { meta: { channel: entry.channel, outcome: entry.outcome }, companyId: id });
  return NextResponse.json({ entry });
}
