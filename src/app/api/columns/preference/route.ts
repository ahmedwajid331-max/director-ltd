import { NextResponse } from "next/server";
import { z } from "zod";
import { keepMyColumns, resetPreference, savePreference } from "@/lib/columns/store";
import { requireUserApi, respond } from "@/lib/columns/api";

const putSchema = z.object({ columns: z.array(z.string()).max(100), baseLayoutId: z.string().max(100).nullish() });

// Save the signed-in user's own default columns.
export async function PUT(request: Request) {
  const auth = await requireUserApi();
  if ("error" in auth) return auth.error;
  const parsed = putSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  return respond(await savePreference(auth.session.userId, parsed.data.columns, parsed.data.baseLayoutId ?? null));
}

// Reset: remove the user's own list, so they follow the recommended layout again.
export async function DELETE() {
  const auth = await requireUserApi();
  if ("error" in auth) return auth.error;
  await resetPreference(auth.session.userId);
  return NextResponse.json({ ok: true });
}

// "Keep mine": dismiss the "recommended layout changed" notice without changing the user's columns.
export async function PATCH() {
  const auth = await requireUserApi();
  if ("error" in auth) return auth.error;
  await keepMyColumns(auth.session.userId);
  return NextResponse.json({ ok: true });
}
