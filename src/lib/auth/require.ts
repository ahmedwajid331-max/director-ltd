import { NextResponse } from "next/server";
import { can, type PermissionKey } from "./permissions";
import type { SessionPayload } from "./session";

// API guard. Returns the error response to send, or null when the caller is signed in and holds the permission.
//   const denied = denyUnless(session, "reports.exportCsv"); if (denied) return denied;
// 401 for no session, 403 (with the missing permission named) for a signed-in user who lacks it.
export function denyUnless(session: SessionPayload | null, key: PermissionKey): NextResponse | null {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session, key)) return NextResponse.json({ error: "You do not have permission to do that.", permission: key }, { status: 403 });
  return null;
}
