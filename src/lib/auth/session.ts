import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import type { UserRole } from "@/lib/types";

const SESSION_COOKIE = "director_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // upper bound; the DB check below can end a session at any time

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
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
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
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySessionToken(token);
  if (!claims?.userId) return null;

  const user = await db.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, name: true, role: true, active: true },
  });
  if (!user || !user.active) return null;

  return { userId: user.id, email: user.email, name: user.name, role: user.role as UserRole };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
