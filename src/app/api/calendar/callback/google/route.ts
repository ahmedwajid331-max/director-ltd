import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { googleCalendarProvider } from "@/lib/calendar/providers/google";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", request.url));

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const settingsUrl = new URL("/settings", request.url);

  if (error) {
    settingsUrl.searchParams.set("calendarError", error);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state || state !== session.userId) {
    settingsUrl.searchParams.set("calendarError", "invalid_callback");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    await googleCalendarProvider.handleCallback!(code, state);
    settingsUrl.searchParams.set("calendarConnected", "google");
  } catch (err) {
    settingsUrl.searchParams.set("calendarError", err instanceof Error ? err.message : "connection_failed");
  }

  return NextResponse.redirect(settingsUrl);
}
