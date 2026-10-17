import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";

const bodySchema = z.object({ body: z.string().trim().min(1).max(4000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Note cannot be empty" }, { status: 400 });

  const company = await db.company.findUnique({ where: { id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const state = await db.userCompanyState.upsert({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    create: { userId: session.userId, companyId: id },
    update: {},
  });
  const note = await db.note.create({
    data: { userCompanyStateId: state.id, body: parsed.data.body, authorName: session.name },
  });

  await logActivity(session, "note_added", { companyId: id });

  return NextResponse.json({ note });
}
