import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { googleCalendarProvider, googleCalendarSetupIssues } from "@/lib/calendar/providers/google";
import { createOAuthState, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS } from "@/lib/calendar/oauth-state";

// Starts "Connect Google Calendar" for the signed-in user (each user connects their OWN Google account).
// The state sent to Google is random and tied to this browser by a signed HttpOnly cookie (see oauth-state.ts); the
// callback refuses anything that does not match it.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "calendar.use");
  if (denied) return denied;

  const issues = googleCalendarSetupIssues();
  if (issues.length > 0) {
    // Names of the missing settings only, never their values.
    return NextResponse.json({ error: "Google Calendar is not configured on the server yet.", missing: issues }, { status: 503 });
  }

  const { state, cookie } = createOAuthState(session.userId);
  const res = NextResponse.redirect(googleCalendarProvider.getAuthUrl!(state));
  res.cookies.set(OAUTH_STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // sent on the top-level redirect back from Google, not on cross-site sub-requests
    path: "/api/calendar",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  return res;
}
