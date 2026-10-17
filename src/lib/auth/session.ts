import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import type { UserRole } from "@/lib/types";
import { resolvePermissions, type PermissionKey } from "@/lib/auth/permissions";
import { SESSION_MAX_AGE_SECONDS, SESSION_TOUCH_INTERVAL_MS } from "@/lib/staff/sessions";

const SESSION_COOKIE = "director_session";

const WEAK_SECRET_PATTERN = /^(dev|replace|change|secret|test|password)/i;

// Refuses to sign or verify with a missing/weak secret in production. In
// development a short secret is tolerated so a fresh checkout still boots,
// but it must still be set.
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  if (process.env.NODE_ENV === "production" && (secret.length < 32 || WEAK_SECRET_PATTERN.test(secret))) {
    throw new Error("AUTH_SECRET is too weak for production (need 32+ random characters, not a placeholder)");
  }
  return secret;
}

function getSecretKey() {
  return new TextEncoder().encode(getAuthSecret());
}

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  // The UserSession row this cookie belongs to (absent on cookies issued before session tracking existed).
  sid?: string;
  // Resolved from the database on every request (never trusted from the cookie): see getSession().
  permissions: PermissionKey[];
}

export async function createSessionToken(payload: Omit<SessionPayload, "permissions">): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecretKey());
}

// Signature/expiry check only. NOT sufficient to authorise a request on its
// own - getSession() below also checks the user row.
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

// The session is only as valid as the user row it points at: the cookie
// proves who the user was when they logged in, the database decides what
// they may do now. A deactivated or deleted user is rejected immediately,
// and the role always comes from the database, so a demotion or promotion
// takes effect on the very next request.
export async function getSession(opts: { touch?: boolean } = {}): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySessionToken(token);
  if (!claims?.userId) return null;

  const userSelect = { id: true, email: true, name: true, role: true, active: true, permissions: true } as const;
  const to = (u: { id: string; email: string; name: string; role: string; permissions: string | null }, sid?: string): SessionPayload => ({
    userId: u.id,
    email: u.email,
    name: u.name,
    role: u.role as UserRole,
    permissions: resolvePermissions(u.role as UserRole, u.permissions),
    ...(sid ? { sid } : {}),
  });

  // Every valid sign-in has a tracked session (see the proxy: cookies without one are refused). An explicit logout, an
  // administrator ending it, or deactivation invalidates the cookie server-side too.
  if (!claims.sid) return null;
  const row = await db.userSession.findUnique({ where: { id: claims.sid }, include: { user: { select: userSelect } } });
  if (!row || row.userId !== claims.userId || row.endedAt || !row.user.active) return null;
  const now = Date.now();
  if (opts.touch !== false && now - row.lastActivityAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    // `touch: false` is used by sign-out so the logout request itself is not recorded as the last time the person was seen.
    // Throttled to one write a minute per session; a failed touch must never fail the request.
    await db.userSession.update({ where: { id: row.id }, data: { lastActivityAt: new Date(now) } }).catch(() => undefined);
  }
  return to(row.user, row.id);
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
