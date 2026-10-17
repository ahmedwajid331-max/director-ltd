import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// CSRF protection for the calendar OAuth round trip. The `state` sent to the provider is a fresh random value, and a
// signed, short-lived, HttpOnly cookie binds that value to THIS signed-in user and THIS browser. The callback only
// proceeds when the cookie verifies and its state equals the one the provider returned. So a crafted callback link (an
// attacker's own authorisation code with a made-up state) cannot attach someone else's Google account to a victim's
// follow-ups: the victim's browser does not hold a matching cookie.
//
// Cookie value: v1.<userId>.<state>.<issuedAtSeconds>.<signature>   (none of the parts can contain a dot)

export const OAUTH_STATE_COOKIE = "dl_cal_oauth";
export const OAUTH_STATE_TTL_SECONDS = 600;

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update("director-ltd:calendar-oauth-state").digest();
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createOAuthState(userId: string, now: number = Date.now()): { state: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  const payload = `v1.${userId}.${state}.${Math.floor(now / 1000)}`;
  return { state, cookie: `${payload}.${sign(payload)}` };
}

export type OAuthStateCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "signature" | "user" | "state" | "expired" };

export function verifyOAuthState(cookie: string | undefined | null, state: string | null | undefined, userId: string, now: number = Date.now()): OAuthStateCheck {
  if (!cookie || !state) return { ok: false, reason: "missing" };
  const parts = cookie.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
  const [, cookieUser, cookieState, issued, signature] = parts;
  if (!safeEqual(signature, sign(parts.slice(0, 4).join(".")))) return { ok: false, reason: "signature" };
  if (!safeEqual(cookieUser, userId)) return { ok: false, reason: "user" };
  if (!safeEqual(cookieState, state)) return { ok: false, reason: "state" };
  const age = Math.floor(now / 1000) - Number(issued);
  if (!Number.isFinite(age) || age < 0 || age > OAUTH_STATE_TTL_SECONDS) return { ok: false, reason: "expired" };
  return { ok: true };
}
