import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth/session";

// Landing point for a cookie whose session is no longer valid (signed out elsewhere, ended by an administrator, account
// deactivated, or issued before session tracking). A page cannot delete a cookie, and the proxy only sees that the
// cookie is correctly signed, so without this the browser would bounce between /login and /dashboard forever. This
// clears it and sends the person to the sign-in page.
export async function GET(request: Request) {
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
