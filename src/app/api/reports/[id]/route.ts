import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { buildCompanyWhere, searchCompanies, isSortableField } from "@/lib/data/companies";
import { filterErrorResponse } from "@/lib/api/filter-errors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || (report.ownerId !== session.userId && session.role === "USER")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const page = Number(searchParams.get("page") ?? "1");
  const sortField = searchParams.get("sortField");
  const sortDir = searchParams.get("sortDir") === "desc" ? "desc" : "asc";

  const filter = JSON.parse(report.filterJson);
  let where;
  try {
    where = buildCompanyWhere({ filter });
  } catch (err) {
    const res = filterErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const result = await searchCompanies({
    where,
    sortField: isSortableField(sortField) ? sortField : "name",
    sortDir,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: 25,
  });

  return NextResponse.json({ report, filter, ...result });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || report.ownerId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.report.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
