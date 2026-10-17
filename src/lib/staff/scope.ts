import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can, type PermissionKey } from "@/lib/auth/permissions";
import type { SessionPayload } from "@/lib/auth/session";

// Who an administrator may see and manage.
//   SUPER_ADMIN - every user.
//   ADMIN (supervisor) - only the users whose supervisor they are (User.managerId = them), plus themselves.
//   USER - only themselves.
// Every staff API and page goes through these helpers, so a direct URL or API call gets exactly the same answer as the UI.

export function userScopeWhere(actor: SessionPayload): Prisma.UserWhereInput {
  if (actor.role === "SUPER_ADMIN") return {};
  if (actor.role === "ADMIN") return { OR: [{ managerId: actor.userId }, { id: actor.userId }] };
  return { id: actor.userId };
}

// The target user if the actor holds `permission` AND the target is inside the actor's scope; otherwise null.
// (Callers answer 404 for null, so existence of out-of-scope accounts is not revealed.)
export async function findScopedUser<S extends Prisma.UserSelect>(actor: SessionPayload, targetId: string, permission: PermissionKey, select: S) {
  if (!can(actor, permission)) return null;
  return db.user.findFirst({ where: { AND: [{ id: targetId }, userScopeWhere(actor)] }, select });
}

// Ids of every user in scope (for aggregate queries). Bounded by headcount, not by data volume.
export async function scopedUserIds(actor: SessionPayload): Promise<string[]> {
  const rows = await db.user.findMany({ where: userScopeWhere(actor), select: { id: true } });
  return rows.map((r) => r.id);
}
