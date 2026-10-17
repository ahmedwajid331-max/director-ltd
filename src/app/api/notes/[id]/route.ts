import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";

// Notes are private to the user who wrote them (they hang off that user's UserCompanyState), so edit/delete are
// strictly owner-only; anyone else - including other users viewing the same company - gets a 404.
const bodySchema = z.object({ body: z.string().trim().min(1).max(4000) });

async function ownNote(id: string, userId: string) {
  return db.note.findFirst({
    where: { id, userCompanyState: { userId } },
    select: { id: true, userCompanyState: { select: { companyId: true } } },
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;
  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Note cannot be empty" }, { status: 400 });
  const existing = await ownNote(id, session.userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const note = await db.note.update({ where: { id }, data: { body: parsed.data.body } });
  await logActivity(session, "note_edited", { companyId: existing.userCompanyState.companyId });
  return NextResponse.json({ note });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;
  const { id } = await params;
  const existing = await ownNote(id, session.userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.note.delete({ where: { id } });
  await logActivity(session, "note_deleted", { companyId: existing.userCompanyState.companyId });
  return NextResponse.json({ ok: true });
}
