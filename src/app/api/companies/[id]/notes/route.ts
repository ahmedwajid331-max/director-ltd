import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const bodySchema = z.object({ body: z.string().min(1).max(4000) });

async function ensureState(userId: string, companyId: string) {
  return db.userCompanyState.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId },
    update: {},
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Note cannot be empty" }, { status: 400 });

  const state = await ensureState(session.userId, id);
  const note = await db.note.create({
    data: { userCompanyStateId: state.id, body: parsed.data.body, authorName: session.name },
  });

  return NextResponse.json({ note });
}
