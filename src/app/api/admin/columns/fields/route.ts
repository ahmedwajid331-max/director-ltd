import { NextResponse } from "next/server";
import { z } from "zod";
import { setFieldSwitches } from "@/lib/columns/store";
import { requireSuperAdminApi, respond } from "@/lib/columns/api";

const schema = z.object({ updates: z.array(z.object({ key: z.string().max(100), enabled: z.boolean() })).min(1).max(200) });

// Super Admin: switch fields on or off for users. Users' saved lists are never rewritten by this.
export async function PUT(request: Request) {
  const auth = await requireSuperAdminApi();
  if ("error" in auth) return auth.error;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  return respond(await setFieldSwitches(auth.session.userId, parsed.data.updates));
}
