import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import type { UserRole } from "@/lib/types";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email and password." }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });

  if (!user || !user.active) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
  });
  await setSessionCookie(token);

  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    db.activityLog.create({
      data: { userId: user.id, action: "login", meta: null },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
