import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { filterAccessResponse, redactDirectorFields } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { buildCompanyWhere, countUnknownDirectorMatches, searchCompanies, isSortableField } from "@/lib/data/companies";
import { withOfficerFreshness } from "@/lib/data/officer-coverage";
import { filterErrorResponse } from "@/lib/api/filter-errors";
import { z } from "zod";
import { parseFilter } from "@/lib/filters/validate";
import { validateReportColumns, validateReportSort } from "@/lib/columns/store";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.viewOwn");
  if (denied) return denied;

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || (report.ownerId !== session.userId && !can(session, "reports.viewOthers"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Opening a report is worth knowing (especially someone else's), but paging / sorting it is not: one event per 30 minutes.
  await logActivity(session, "report_viewed", { meta: { name: report.name }, reportId: id, dedupeMs: 30 * 60_000 });

  const { searchParams } = new URL(request.url);
  const page = Number(searchParams.get("page") ?? "1");
  const sortField = searchParams.get("sortField");
  const sortDir = searchParams.get("sortDir") === "desc" ? "desc" : "asc";

  const filter = JSON.parse(report.filterJson);
  let where;
  try {
    where = buildCompanyWhere({ filter, userId: report.ownerId });
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

  const unknown = await countUnknownDirectorMatches({ filter, userId: report.ownerId }, result.total);

  return NextResponse.json({
    report,
    filter,
    ...result,
    rows: withOfficerFreshness(result.rows).map((r) => (can(session, "companies.directors") ? r : redactDirectorFields(r))),
    officerCoverage: { hasDirectorRules: unknown !== null, confirmed: result.total, unknown: unknown ?? 0 },
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.edit");
  if (denied) return denied;

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || report.ownerId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.report.delete({ where: { id } });
  await logActivity(session, "report_deleted", { meta: { name: report.name }, reportId: id });
  return NextResponse.json({ ok: true });
}

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    filter: z.unknown().optional(),
    dailyRefresh: z.boolean().optional(),
    columns: z.array(z.string().max(60)).max(100).nullish(),
    sort: z.object({ field: z.string().max(40), dir: z.string().max(4) }).nullish(),
  })
  .strict();

// Edits an existing saved report IN PLACE (same id, same owner). Mirrors POST's validation.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.edit");
  if (denied) return denied;

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || report.ownerId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { name, description, filter, dailyRefresh, columns, sort } = parsed.data;

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description?.trim() || null;
  if (dailyRefresh !== undefined) data.dailyRefresh = dailyRefresh;
  // columns / sort: undefined = leave as is; null = forget (back to the original table); otherwise validate and store.
  if (columns !== undefined) {
    if (columns === null) data.columnsJson = null;
    else {
      const c = await validateReportColumns(columns);
      if (!c.ok) return NextResponse.json({ error: c.error }, { status: c.status });
      data.columnsJson = JSON.stringify(c.value);
    }
  }
  if (sort !== undefined) {
    if (sort === null) data.sortJson = null;
    else {
      const sv = validateReportSort(sort);
      if (!sv.ok) return NextResponse.json({ error: sv.error }, { status: sv.status });
      data.sortJson = JSON.stringify(sv.value);
    }
  }
  if (filter !== undefined) {
    const blocked = filterAccessResponse(session, filter);
    if (blocked) return blocked;
    const checked = parseFilter(filter);
    if (!checked.ok || !checked.filter) {
      return NextResponse.json(
        { error: "Invalid filter.", details: checked.ok ? ["filter is required"] : checked.errors.slice(0, 10) },
        { status: 400 }
      );
    }
    data.filterJson = JSON.stringify(checked.filter);
    data.resultCount = await db.company.count({ where: buildCompanyWhere({ filter: checked.filter, userId: report.ownerId }) });
    data.lastRunAt = new Date();
    data.lastRefreshError = null;
  }

  const updated = await db.report.update({ where: { id }, data });
  await logActivity(session, "report_updated", { meta: { name: updated.name }, reportId: id });
  return NextResponse.json({ report: updated });
}
