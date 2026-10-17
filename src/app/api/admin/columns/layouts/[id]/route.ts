import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteLayout, updateLayout } from "@/lib/columns/store";
import { requireSuperAdminApi, respond } from "@/lib/columns/api";

const schema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(300).nullish(),
  columns: z.array(z.string()).max(100).optional(),
  isDefault: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSuperAdminApi();
  if ("error" in auth) return auth.error;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { id } = await params;
  return respond(await updateLayout(auth.session.userId, id, parsed.data));
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSuperAdminApi();
  if ("error" in auth) return auth.error;
  const { id } = await params;
  return respond(await deleteLayout(auth.session.userId, id));
}
