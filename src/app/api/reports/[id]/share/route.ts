import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { can } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";

const bodySchema = z.object({ method: z.enum(["link", "whatsapp", "email", "device", "summary"]) });

// Sharing a report is a browser action (copying a link, opening WhatsApp / the mail app), so the server cannot perform
// or block it - but it refuses to record it for someone who may not share, and records it for those who may. The link
// itself grants nothing: opening it still requires a signed-in user who is allowed to see the report.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = denyUnless(session, "reports.share");
  if (denied || !session) return denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const report = await db.report.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true } });
  if (!report || (report.ownerId !== session.userId && !can(session, "reports.viewOthers"))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logActivity(session, "report_shared", { meta: { name: report.name, method: parsed.data.method }, reportId: id });
  return NextResponse.json({ ok: true });
}
