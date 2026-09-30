import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const bodySchema = z.object({
  followed: z.boolean().optional(),
  trashed: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const company = await db.company.findUnique({ where: { id } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  // The signed session cookie can outlive the user row it points to (e.g.
  // a database reseed). Writing UserCompanyState with a userId that no
  // longer exists violates its foreign key and previously surfaced as an
  // opaque 500. Detect it here and ask for re-authentication instead.
  const userExists = await db.user.findUnique({ where: { id: session.userId }, select: { id: true } });
  if (!userExists) {
    return NextResponse.json(
      { error: "Your session is no longer valid. Please sign in again." },
      { status: 401 }
    );
  }

  const state = await db.userCompanyState.upsert({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    create: { userId: session.userId, companyId: id, ...parsed.data },
    update: parsed.data,
  });

  await db.activityLog.create({
    data: {
      userId: session.userId,
      action: parsed.data.followed !== undefined ? "company_follow_toggle" : "company_trash_toggle",
      meta: JSON.stringify({ companyId: id, companyName: company.name, ...parsed.data }),
    },
  });

  return NextResponse.json({ state });
}
