import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "./session";
import type { UserRole } from "@/lib/types";
import { can, type PermissionKey } from "./permissions";

const ROLE_RANK: Record<UserRole, number> = {
  USER: 0,
  ADMIN: 1,
  SUPER_ADMIN: 2,
};

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  // Not "/login": a correctly signed cookie whose session has ended would make the proxy bounce /login back here. This
  // route clears the cookie first.
  if (!session) redirect("/api/auth/expired");
  return session;
}

export async function requireRole(minRole: UserRole): Promise<SessionPayload> {
  const session = await requireSession();
  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    redirect("/dashboard");
  }
  return session;
}

export function hasRole(session: SessionPayload | null, minRole: UserRole): boolean {
  if (!session) return false;
  return ROLE_RANK[session.role] >= ROLE_RANK[minRole];
}

export function hasPermission(session: SessionPayload | null, key: PermissionKey): boolean {
  return can(session, key);
}

// Page guard: signed in AND allowed. A signed-in user without the permission is sent to the dashboard (never shown the page).
export async function requirePermission(key: PermissionKey): Promise<SessionPayload> {
  const session = await requireSession();
  if (!can(session, key)) redirect("/dashboard");
  return session;
}
