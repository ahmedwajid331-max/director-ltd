import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import type { StoreResult } from "./store";

// Shared guards for the column-settings routes. The role is always checked here, on the server.
export async function requireUserApi() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  return { session } as const;
}

export async function requireSuperAdminApi() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  if (session.role !== "SUPER_ADMIN") return { error: NextResponse.json({ error: "Only a Super Admin can change column settings." }, { status: 403 }) } as const;
  return { session } as const;
}

export function respond<T>(result: StoreResult<T>, okStatus = 200) {
  return result.ok ? NextResponse.json(result.value, { status: okStatus }) : NextResponse.json({ error: result.error }, { status: result.status });
}
