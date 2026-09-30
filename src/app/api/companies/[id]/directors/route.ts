import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().max(100).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(50).optional(),
  occupation: z.string().max(150).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter at least a name." }, { status: 400 });

  const company = await db.company.findUnique({ where: { id } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const director = await db.director.create({
    data: {
      companyId: id,
      name: parsed.data.name,
      role: parsed.data.role || "contact",
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
      occupation: parsed.data.occupation || null,
      manuallyAdded: true,
    },
  });

  // Keep the denormalized director count/single-director flag (used by the
  // fast filter engine) consistent with the actual director rows.
  const nextCount = company.directorCount + 1;
  await db.company.update({
    where: { id },
    data: { directorCount: nextCount, singleDirector: nextCount === 1 },
  });

  await db.activityLog.create({
    data: {
      userId: session.userId,
      action: "director_contact_added",
      meta: JSON.stringify({ companyId: id, name: parsed.data.name }),
    },
  });

  return NextResponse.json({ director });
}
