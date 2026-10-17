import { NextResponse } from "next/server";
import { z } from "zod";
import { createLayout } from "@/lib/columns/store";
import { requireSuperAdminApi, respond } from "@/lib/columns/api";

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).nullish(),
  columns: z.array(z.string()).max(100),
  makeDefault: z.boolean().optional(),
});

export async function POST(request: Request) {
  const auth = await requireSuperAdminApi();
  if ("error" in auth) return auth.error;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give the layout a name (up to 80 characters)." }, { status: 400 });
  return respond(await createLayout(auth.session.userId, parsed.data), 201);
}
