import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { googleCalendarProvider, isGoogleCalendarConfigured } from "@/lib/calendar/providers/google";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isGoogleCalendarConfigured()) {
    return NextResponse.json(
      { error: "Google Calendar is not configured on the server yet." },
      { status: 503 }
    );
  }

  const url = googleCalendarProvider.getAuthUrl!(session.userId);
  return NextResponse.redirect(url);
}
