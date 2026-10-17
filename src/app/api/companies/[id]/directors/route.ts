import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().max(100).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(50).optional(),
  occupation: z.string().max(150).optional(),
});

// Adds a *CRM contact* (a person the user actually deals with). It is stored
// in its own table, private to the user, and deliberately does NOT touch the
// Companies House officer list, directorCount or singleDirector - director
// filters only ever reflect Companies House data.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "crm.notes");
  if (denied) return denied;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter at least a name." }, { status: 400 });

  const company = await db.company.findUnique({ where: { id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const contact = await db.crmContact.create({
    data: {
      userId: session.userId,
      companyId: id,
      name: parsed.data.name,
      role: parsed.data.role || "contact",
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
      occupation: parsed.data.occupation || null,
    },
  });

  await logActivity(session, "director_contact_added", { meta: { name: parsed.data.name }, companyId: id });

  // Same response shape the UI already consumed (it shows "manually added").
  return NextResponse.json({ director: { ...contact, manuallyAdded: true, appointedOn: null, resignedOn: null, nationality: null } });
}
