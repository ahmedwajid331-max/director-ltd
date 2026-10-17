import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { findScopedUser } from "@/lib/staff/scope";
import { AVATAR_TYPES, findAvatar, isUserId, readAvatar } from "@/lib/avatar";

// Serves a stored picture to its owner, a Super Admin, or someone who manages staff and has this person in their own scope
// (the same people the Users page already shows them). Anyone else, and anyone signed out, gets nothing.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession({ touch: false });
  if (!session) return new NextResponse(null, { status: 401 });
  const { id } = await params;
  if (!isUserId(id)) return new NextResponse(null, { status: 404 });
  if (id !== session.userId && session.role !== "SUPER_ADMIN") {
    const visible = can(session, "staff.manage") && (await findScopedUser(session, id, "staff.manage", { id: true }));
    if (!visible) return new NextResponse(null, { status: 404 });
  }
  const found = await findAvatar(id);
  if (!found) return new NextResponse(null, { status: 404 });
  const body = await readAvatar(id, found.ext);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": AVATAR_TYPES[found.ext],
      "Content-Length": String(body.length),
      "Cache-Control": "private, max-age=31536000, immutable", // safe: the URL carries a version that changes with the file
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
