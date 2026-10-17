import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";

// CRM contacts are private to the user who added them: edit / delete are owner-only (anyone else gets a 404).
const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().max(100).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(50).optional(),
  occupation: z.string().max(150).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;
  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter at least a name (and a valid email, if given)." }, { status: 400 });
  const existing = await db.crmContact.findFirst({ where: { id, userId: session.userId }, select: { id: true, companyId: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const contact = await db.crmContact.update({
    where: { id },
    data: {
      name: parsed.data.name,
      role: parsed.data.role || "contact",
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
      occupation: parsed.data.occupation || null,
    },
  });
  await logActivity(session, "contact_edited", { meta: { name: contact.name }, companyId: existing.companyId });
  return NextResponse.json({ contact });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;
  const { id } = await params;
  const existing = await db.crmContact.findFirst({ where: { id, userId: session.userId }, select: { id: true, companyId: true, name: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.crmContact.delete({ where: { id } });
  await logActivity(session, "contact_deleted", { meta: { name: existing.name }, companyId: existing.companyId });
  return NextResponse.json({ ok: true });
}
