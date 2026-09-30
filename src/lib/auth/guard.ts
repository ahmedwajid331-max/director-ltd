import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "./session";
import type { UserRole } from "@/lib/types";

const ROLE_RANK: Record<UserRole, number> = {
  USER: 0,
  ADMIN: 1,
  SUPER_ADMIN: 2,
};

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
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
