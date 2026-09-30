import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hasRole } from "@/lib/auth/guard";

const bodySchema = z.object({
  active: z.boolean().optional(),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!hasRole(session, "ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  if (parsed.data.role && parsed.data.role !== "USER" && session!.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Only a Super Admin can assign that role." }, { status: 403 });
  }

  if (id === session!.userId && (parsed.data.active === false || parsed.data.role === "USER")) {
    return NextResponse.json({ error: "You cannot deactivate or demote your own account." }, { status: 400 });
  }

  const user = await db.user.update({
    where: { id },
    data: parsed.data,
    select: { id: true, email: true, name: true, role: true, active: true },
  });

  return NextResponse.json({ user });
}
