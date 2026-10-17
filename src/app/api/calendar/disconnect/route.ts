import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { getProvider } from "@/lib/calendar/registry";

const bodySchema = z.object({ provider: z.enum(["GOOGLE", "MICROSOFT"]) });

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "calendar.use");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const connection = await db.calendarConnection.findUnique({
    where: { userId_provider: { userId: session.userId, provider: parsed.data.provider } },
  });
  if (!connection) return NextResponse.json({ ok: true });

  await getProvider(parsed.data.provider).disconnect(connection);
  return NextResponse.json({ ok: true });
}
