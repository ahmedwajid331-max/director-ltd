import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clearSessionCookie, getSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/activity";

// Explicit sign-out: the only thing that writes a session's end time. The cookie alone is no longer enough to get back
// in afterwards (getSession checks the session row), so a copied cookie stops working too.
export async function POST(request: Request) {
  const session = await getSession({ touch: false });
  if (session?.sid) {
    // Only the request that actually closes the row records the sign-out, so a repeated or concurrent logout adds nothing.
    const closed = await db.userSession.updateMany({ where: { id: session.sid, endedAt: null }, data: { endedAt: new Date(), endReason: "logout" } });
    if (closed.count === 1) await logActivity({ userId: session.userId, sid: session.sid }, "logout");
  }
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
