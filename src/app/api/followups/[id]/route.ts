import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const bodySchema = z.object({ done: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const followUp = await db.followUp.findUnique({ where: { id } });
  if (!followUp || followUp.userId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await db.followUp.update({ where: { id }, data: { done: parsed.data.done } });
  return NextResponse.json({ followUp: updated });
}
