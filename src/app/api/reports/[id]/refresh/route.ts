import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { buildCompanyWhere } from "@/lib/data/companies";
import { filterErrorResponse } from "@/lib/api/filter-errors";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.edit");
  if (denied) return denied;

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || report.ownerId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const filter = JSON.parse(report.filterJson);
  let resultCount: number;
  try {
    resultCount = await db.company.count({ where: buildCompanyWhere({ filter, userId: report.ownerId }) });
  } catch (err) {
    const res = filterErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const updated = await db.report.update({
    where: { id },
    data: { resultCount, lastRunAt: new Date() },
  });

  await logActivity(session, "report_refreshed", { meta: { name: updated.name }, reportId: id });
  return NextResponse.json({ report: updated });
}
