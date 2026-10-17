import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { listAvailableProviders } from "@/lib/calendar/registry";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "calendar.use");
  if (denied) return denied;

  const connections = await db.calendarConnection.findMany({ where: { userId: session.userId } });

  return NextResponse.json({
    providers: listAvailableProviders(),
    connections: connections.map((c) => ({
      provider: c.provider,
      status: c.status,
      accountEmail: c.accountEmail,
      lastSyncAt: c.lastSyncAt,
      lastSyncError: c.lastSyncError,
    })),
  });
}
