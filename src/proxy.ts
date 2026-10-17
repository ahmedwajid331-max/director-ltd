import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "director_session";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/companies",
  "/reports",
  "/watches",
  "/saved",
  "/red-flags",
  "/trash",
  "/calendar",
  "/users",
  "/admin",
  "/settings",
  "/work",
  "/timesheets",
];

async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    // Cookies issued before session tracking carry no session id. They cannot be tracked or ended by a logout, so they are
    // treated as signed out (the person signs in once and gets a tracked session). getSession() applies the same rule;
    // the two must agree or /login and the app would redirect to each other.
    return typeof payload.sid === "string" && payload.sid.length > 0;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authed = await isValidSession(token);

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  if (isProtected && !authed) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && authed) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/companies/:path*",
    "/reports/:path*",
    "/watches/:path*",
    "/saved/:path*",
    "/red-flags/:path*",
    "/trash/:path*",
    "/calendar/:path*",
    "/users/:path*",
    "/admin/:path*",
    "/settings/:path*",
    "/work/:path*",
    "/timesheets/:path*",
    "/login",
  ],
};
