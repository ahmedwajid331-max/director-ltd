import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const followUps = await db.followUp.findMany({
    where: { userId: session.userId },
    orderBy: { dueDate: "asc" },
    include: { userCompanyState: { include: { company: true } } },
  });

  return NextResponse.json({
    followUps: followUps.map((f) => ({
      id: f.id,
      dueDate: f.dueDate,
      note: f.note,
      done: f.done,
      companyId: f.userCompanyState.company.id,
      companyName: f.userCompanyState.company.name,
    })),
  });
}
