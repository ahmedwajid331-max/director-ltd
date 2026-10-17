import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { ADMIN_ONLY_KEYS, parsePermissions, resolvePermissions, validatePermissionList } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { findScopedUser } from "@/lib/staff/scope";
import { MAX_RATE_MINOR, isCurrency } from "@/lib/staff/money";
import type { UserRole } from "@/lib/types";

const bodySchema = z
  .object({
    active: z.boolean().optional(),
    role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
    // null = back to the role's default set
    permissions: z.array(z.string().max(60)).max(100).nullable().optional(),
    managerId: z.string().max(64).nullable().optional(),
    hourlyRateMinor: z.number().int().min(0).max(MAX_RATE_MINOR).nullable().optional(),
    rateCurrency: z.string().max(3).optional(),
  })
  .strict();

// Authorization model (enforced here, never by hiding UI):
//  - The caller needs staff.manage and the target must be inside their scope (a supervisor's own team; everyone for a
//    Super Admin). Out-of-scope accounts answer 404, so their existence is not revealed.
//  - SUPER_ADMIN may change anything, except they cannot deactivate/demote themselves and the last active Super Admin can
//    never be removed.
//  - ADMIN may only activate/deactivate accounts whose role is USER. Roles, permissions, supervisors and pay rates are
//    Super Admin only. Nobody can change their own role or permissions.
//  - Only the fields present in the request are touched; everything else (including a user's saved columns and other
//    preferences) is left exactly as it was.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = denyUnless(session, "staff.manage");
  if (denied || !session) return denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const input = parsed.data;

  const target = await findScopedUser(session, id, "staff.manage", { id: true, role: true, active: true, permissions: true, hourlyRateMinor: true, rateCurrency: true });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const actorIsSuper = session.role === "SUPER_ADMIN";
  const touchesSuperOnly = input.role !== undefined || input.permissions !== undefined || input.managerId !== undefined || input.hourlyRateMinor !== undefined || input.rateCurrency !== undefined;

  if (!actorIsSuper) {
    if (target.role !== "USER") return NextResponse.json({ error: "Only a Super Admin can modify Admin or Super Admin accounts." }, { status: 403 });
    if (touchesSuperOnly) return NextResponse.json({ error: "Only a Super Admin can change roles, permissions, supervisors or pay rates." }, { status: 403 });
  }

  const isSelf = id === session.userId;
  if (isSelf && (input.active === false || (input.role && input.role !== session.role))) {
    return NextResponse.json({ error: "You cannot deactivate or change the role of your own account." }, { status: 400 });
  }
  if (isSelf && input.permissions !== undefined) return NextResponse.json({ error: "You cannot change your own permissions." }, { status: 400 });

  // Never allow the platform to end up with no active Super Admin.
  const losesSuper =
    target.role === "SUPER_ADMIN" && target.active && (input.active === false || (input.role !== undefined && input.role !== "SUPER_ADMIN"));
  if (losesSuper) {
    const otherSupers = await db.user.count({ where: { role: "SUPER_ADMIN", active: true, id: { not: id } } });
    if (otherSupers === 0) return NextResponse.json({ error: "There must always be at least one active Super Admin." }, { status: 400 });
  }

  const newRole = (input.role ?? target.role) as UserRole;
  const data: Record<string, unknown> = {};
  const changed: string[] = [];

  if (input.active !== undefined && input.active !== target.active) {
    data.active = input.active;
    changed.push(input.active ? "activated" : "deactivated");
  }
  if (input.role !== undefined && input.role !== target.role) {
    data.role = input.role;
    changed.push(`role ${target.role}->${input.role}`);
  }

  let permissionChange: { granted: string[]; revoked: string[] } | null = null;
  if (newRole === "SUPER_ADMIN" && input.permissions) return NextResponse.json({ error: "A Super Admin always has every permission." }, { status: 400 });
  if (input.permissions !== undefined) {
    let next: string | null = null;
    if (input.permissions !== null) {
      const v = validatePermissionList(input.permissions, newRole);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      next = JSON.stringify(v.keys);
    }
    const before = resolvePermissions(newRole, target.permissions);
    const after = resolvePermissions(newRole, next);
    permissionChange = { granted: after.filter((k) => !before.includes(k)), revoked: before.filter((k) => !after.includes(k)) };
    data.permissions = next;
    changed.push("permissions");
  } else if (input.role === "USER" && target.role !== "USER") {
    // Demoted to a plain user: administration keys cannot stay in an explicit list.
    const explicit = parsePermissions(target.permissions);
    if (explicit) data.permissions = JSON.stringify(explicit.filter((k) => !ADMIN_ONLY_KEYS.includes(k)));
  }

  if (input.managerId !== undefined) {
    if (input.managerId !== null) {
      if (input.managerId === id) return NextResponse.json({ error: "Someone cannot supervise themselves." }, { status: 400 });
      const mgr = await db.user.findFirst({ where: { id: input.managerId, active: true, role: { in: ["ADMIN", "SUPER_ADMIN"] } }, select: { id: true } });
      if (!mgr) return NextResponse.json({ error: "Choose an active Admin or Super Admin as supervisor." }, { status: 400 });
    }
    data.managerId = input.managerId;
    changed.push("supervisor");
  }
  // Rate / currency changes record the old and new value. Timesheets already approved keep the rate captured at approval.
  const rateChange: Record<string, unknown> = {};
  if (input.hourlyRateMinor !== undefined && input.hourlyRateMinor !== target.hourlyRateMinor) {
    data.hourlyRateMinor = input.hourlyRateMinor;
    changed.push("pay rate");
    rateChange.rateFromMinor = target.hourlyRateMinor;
    rateChange.rateToMinor = input.hourlyRateMinor;
  }
  if (input.rateCurrency !== undefined) {
    if (!isCurrency(input.rateCurrency)) return NextResponse.json({ error: "Unsupported currency." }, { status: 400 });
    if (input.rateCurrency !== target.rateCurrency) {
      data.rateCurrency = input.rateCurrency;
      changed.push("currency");
      rateChange.currencyFrom = target.rateCurrency;
      rateChange.currencyTo = input.rateCurrency;
    }
  }

  if (Object.keys(data).length === 0) {
    const same = await db.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true, active: true } });
    return NextResponse.json({ user: same });
  }

  const user = await db.user.update({ where: { id }, data, select: { id: true, email: true, name: true, role: true, active: true } });

  // A deactivated account is signed out everywhere immediately (getSession already refuses it; this records the end).
  if (input.active === false) {
    await db.userSession.updateMany({ where: { userId: id, endedAt: null }, data: { endedAt: new Date(), endReason: "deactivated" } });
  }

  await logActivity(session, "user_updated", { meta: { targetId: id, changed, ...rateChange } });
  if (permissionChange) {
    await logActivity(session, "permissions_changed", { meta: { targetId: id, granted: permissionChange.granted.length, revoked: permissionChange.revoked.length, grantedKeys: permissionChange.granted, revokedKeys: permissionChange.revoked } });
  }

  return NextResponse.json({ user });
}
