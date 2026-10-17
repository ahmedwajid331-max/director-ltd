import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword, getDummyHash } from "@/lib/auth/password";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { clearFailedLogins, clientIp, isLoginBlocked, recordFailedLogin } from "@/lib/auth/login-throttle";
import { logActivity } from "@/lib/activity";
import type { UserRole } from "@/lib/types";

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

const GENERIC_FAILURE = "Invalid email or password.";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email and password." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;
  const ip = clientIp(request);

  // Throttled before any password work, and with the same response shape
  // whether or not the account exists.
  const gate = await isLoginBlocked(email, ip);
  if (gate.blocked) {
    return NextResponse.json(
      { error: "Too many failed attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } }
    );
  }

  const user = await db.user.findUnique({ where: { email } });

  // Always run one bcrypt comparison so response time does not reveal
  // whether the email is registered or the account is deactivated.
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !user.active || !valid) {
    await recordFailedLogin(email, ip);
    // Recorded against a real account only (an unknown address has no owner, and the log must not collect guesses).
    // No IP or password data is stored; the reason distinguishes a deactivated account from a wrong password.
    if (user) await logActivity({ userId: user.id }, "login_failed", { meta: { reason: !user.active ? "inactive" : "bad_password" }, dedupeMs: 10_000 });
    return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
  }

  const now = new Date();
  const [session] = await db.$transaction([
    db.userSession.create({
      data: { userId: user.id, startedAt: now, lastActivityAt: now, userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null },
      select: { id: true },
    }),
    db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
  ]);
  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    sid: session.id,
  });
  await setSessionCookie(token);
  await clearFailedLogins(email, ip);
  await logActivity({ userId: user.id, sid: session.id }, "login");

  return NextResponse.json({ ok: true });
}
