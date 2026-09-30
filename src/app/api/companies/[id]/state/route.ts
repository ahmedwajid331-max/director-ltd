import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const bodySchema = z
  .object({
    followed: z.boolean().optional(),
    trashed: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.followed !== undefined || v.trashed !== undefined, { message: "Nothing to change" });

// Follow and Trash are mutually exclusive, per user:
//  - trashing a followed company removes it from Followed (it moves to Trash);
//  - following a trashed company restores it from Trash;
//  - restoring (trashed:false) leaves the company un-followed.
// So a company can never be in both lists at once.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const company = await db.company.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const next: { followed?: boolean; trashed?: boolean } = { ...parsed.data };
  if (next.trashed === true) next.followed = false;
  if (next.followed === true) next.trashed = false;

  const state = await db.userCompanyState.upsert({
    where: { userId_companyId: { userId: session.userId, companyId: id } },
    create: { userId: session.userId, companyId: id, ...next },
    update: next,
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
