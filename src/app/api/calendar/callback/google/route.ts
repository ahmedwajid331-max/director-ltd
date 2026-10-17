import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { googleCalendarProvider } from "@/lib/calendar/providers/google";
import { OAUTH_STATE_COOKIE, verifyOAuthState } from "@/lib/calendar/oauth-state";
import { syncOpenFollowUpsForUser } from "@/lib/calendar/sync-followup";
import { logActivity } from "@/lib/activity";
import { makeLogger } from "@/lib/log";

const log = makeLogger("calendar");

// Only these codes ever reach the Settings page (it shows a fixed sentence for each); provider error text is logged,
// never put into a URL.
const KNOWN_ERRORS = new Set(["access_denied", "invalid_callback", "connection_failed", "no_refresh_token", "not_permitted"]);

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", request.url));

  const settingsUrl = new URL("/settings", request.url);
  const fail = (code: string) => {
    settingsUrl.searchParams.set("calendarError", KNOWN_ERRORS.has(code) ? code : "connection_failed");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/calendar" }); // one-time use, success or not
    return res;
  };

  if (denyUnless(session, "calendar.use")) return fail("not_permitted");

  const { searchParams } = new URL(request.url);
  const error = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // The state must match the one this browser was given when it started the connection, for THIS signed-in user.
  const check = verifyOAuthState((await cookies()).get(OAUTH_STATE_COOKIE)?.value, state, session.userId);
  if (!check.ok) {
    log.warn("calendar.oauth_state_rejected", { reason: check.reason, userId: session.userId });
    return fail("invalid_callback");
  }
  if (error) return fail(error === "access_denied" ? "access_denied" : "connection_failed");
  if (!code) return fail("invalid_callback");

  try {
    await googleCalendarProvider.handleCallback!(code, session.userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("calendar.connect_failed", { userId: session.userId, error: message.slice(0, 300) });
    return fail(/refresh token/i.test(message) ? "no_refresh_token" : "connection_failed");
  }

  await logActivity(session, "calendar_connected", { meta: { provider: "google" } });
  // Put the follow-ups that are already open into the new calendar too. Best-effort and in the background: a slow or
  // failing Google call never delays or breaks the connection (each follow-up records its own error if one happens).
  void syncOpenFollowUpsForUser(session.userId).catch((e) => log.error("calendar.backfill_failed", { userId: session.userId, error: String(e).slice(0, 300) }));

  settingsUrl.searchParams.set("calendarConnected", "google");
  const res = NextResponse.redirect(settingsUrl);
  res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/calendar" });
  return res;
}
