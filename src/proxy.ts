import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "director_session";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/companies",
  "/reports",
  "/watches",
  "/trash",
  "/calendar",
  "/users",
  "/admin",
  "/settings",
];

async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return true;
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
    "/trash/:path*",
    "/calendar/:path*",
    "/users/:path*",
    "/admin/:path*",
    "/settings/:path*",
    "/login",
  ],
};
