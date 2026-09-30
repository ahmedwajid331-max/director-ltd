import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
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
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).default("USER"),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!hasRole(session, "ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });

  // Only a Super Admin can grant elevated roles.
  if (parsed.data.role !== "USER" && session!.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Only a Super Admin can assign that role." }, { status: 403 });
  }

  const existing = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (existing) return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await db.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase(),
      passwordHash,
      role: parsed.data.role,
    },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });

  return NextResponse.json({ user });
}
