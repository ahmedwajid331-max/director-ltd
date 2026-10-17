import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/password-policy";
import { denyUnless } from "@/lib/auth/require";
import { NEW_ACCOUNT_DEFAULT, validatePermissionList } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/activity";
import { userScopeWhere } from "@/lib/staff/scope";
import { MAX_RATE_MINOR, isCurrency } from "@/lib/staff/money";

// The staff list, limited to the caller's scope (everyone for a Super Admin; a supervisor's own team otherwise).
export async function GET() {
  const session = await getSession();
  const denied = denyUnless(session, "staff.view");
  if (denied || !session) return denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const users = await db.user.findMany({
    where: userScopeWhere(session),
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      createdAt: true,
      lastLoginAt: true,
      _count: { select: { reports: true } },
    },
  });

  return NextResponse.json({ users });
}

const bodySchema = z.object({
  name: z.string().min(1).max(150),
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).default("USER"),
  // Super Admin only (ignored / refused for anyone else):
  permissions: z.array(z.string().max(60)).max(100).optional(),
  managerId: z.string().max(64).nullable().optional(),
  hourlyRateMinor: z.number().int().min(0).max(MAX_RATE_MINOR).nullable().optional(),
  rateCurrency: z.string().max(3).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  const denied = denyUnless(session, "staff.manage");
  if (denied || !session) return denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const actorIsSuper = session.role === "SUPER_ADMIN";

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });
  const input = parsed.data;

  // Only a Super Admin can grant elevated roles, choose permissions, set a supervisor or a pay rate.
  if (input.role !== "USER" && !actorIsSuper) return NextResponse.json({ error: "Only a Super Admin can assign that role." }, { status: 403 });
  if (!actorIsSuper && (input.permissions !== undefined || input.managerId !== undefined || input.hourlyRateMinor !== undefined || input.rateCurrency !== undefined)) {
    return NextResponse.json({ error: "Only a Super Admin can set permissions, supervisors or pay rates." }, { status: 403 });
  }

  // Permissions: least privilege unless a Super Admin ticks more. Admin accounts without an explicit list get the full
  // administrator set (null = role default); Super Admin is never restricted.
  let permissions: string | null = null;
  if (input.role === "SUPER_ADMIN") {
    if (input.permissions !== undefined) return NextResponse.json({ error: "A Super Admin always has every permission." }, { status: 400 });
  } else if (input.permissions !== undefined) {
    const v = validatePermissionList(input.permissions, input.role);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    permissions = JSON.stringify(v.keys);
  } else if (input.role === "USER") {
    permissions = JSON.stringify(NEW_ACCOUNT_DEFAULT);
  }

  // Supervisor: a Super Admin may pick any active Admin / Super Admin; an Admin's new users join their own team.
  let managerId: string | null = null;
  if (actorIsSuper) {
    if (input.managerId) {
      const mgr = await db.user.findFirst({ where: { id: input.managerId, active: true, role: { in: ["ADMIN", "SUPER_ADMIN"] } }, select: { id: true } });
      if (!mgr) return NextResponse.json({ error: "Choose an active Admin or Super Admin as supervisor." }, { status: 400 });
      managerId = mgr.id;
    }
  } else {
    managerId = session.userId;
  }

  if (input.rateCurrency !== undefined && !isCurrency(input.rateCurrency)) return NextResponse.json({ error: "Unsupported currency." }, { status: 400 });

  const weakness = validatePassword(input.password, { email: input.email });
  if (weakness) return NextResponse.json({ error: weakness }, { status: 400 });

  const email = input.email.toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });

  const user = await db.user.create({
    data: {
      name: input.name,
      email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      permissions,
      managerId,
      hourlyRateMinor: input.hourlyRateMinor ?? null,
      ...(input.rateCurrency ? { rateCurrency: input.rateCurrency } : {}),
    },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true, permissions: true },
  });

  await logActivity(session, "user_created", { meta: { targetId: user.id, role: user.role, permissionCount: permissions ? (JSON.parse(permissions) as string[]).length : null, managerId } });

  return NextResponse.json({ user });
}
