import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { compileFilterToWhere } from "@/lib/filters/compile";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || report.ownerId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const filter = JSON.parse(report.filterJson);
  const where = compileFilterToWhere(filter);
  const resultCount = await db.company.count({ where });

  const updated = await db.report.update({
    where: { id },
    data: { resultCount, lastRunAt: new Date() },
  });

  return NextResponse.json({ report: updated });
}
