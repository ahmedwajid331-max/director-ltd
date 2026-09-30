import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/password-policy";
import { hasRole } from "@/lib/auth/guard";

export async function GET() {
  const session = await getSession();
  if (!hasRole(session, "ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await db.user.findMany({
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
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !hasRole(session, "ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });

  // Only a Super Admin can grant elevated roles.
  if (parsed.data.role !== "USER" && session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Only a Super Admin can assign that role." }, { status: 403 });
  }

  const weakness = validatePassword(parsed.data.password, { email: parsed.data.email });
  if (weakness) return NextResponse.json({ error: weakness }, { status: 400 });

  const email = parsed.data.email.toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });

  const user = await db.user.create({
    data: {
      name: parsed.data.name,
      email,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
    },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });

  await db.activityLog.create({
    data: { userId: session.userId, action: "user_created", meta: JSON.stringify({ targetId: user.id, role: user.role }) },
  });

  return NextResponse.json({ user });
}
