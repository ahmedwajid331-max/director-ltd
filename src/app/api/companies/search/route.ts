import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { buildCompanyWhere, isSortableField, searchCompanies } from "@/lib/data/companies";
import { filterErrorResponse } from "@/lib/api/filter-errors";
import { parseFilter } from "@/lib/filters/validate";
import { countActiveRules } from "@/lib/filters/types";

const bodySchema = z.object({
  filter: z.unknown().optional(),
  q: z.string().max(200).optional(),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  sortField: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  scope: z.enum(["all", "followed", "trashed"]).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { filter, q, page, pageSize, sortField, sortDir, scope } = parsed.data;

  let where;
  try {
    // Default view excludes the user's trashed companies.
    where = buildCompanyWhere({ filter, q, scope: scope ?? "all", userId: session.userId });
  } catch (err) {
    const res = filterErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const result = await searchCompanies({
    where,
    sortField: isSortableField(sortField) ? sortField : "name",
    sortDir: sortDir ?? "asc",
    page,
    pageSize,
  });

  // Super Admin visibility: record meaningful searches (a filter or search
  // term, first page). Identical repeats within a minute (re-sorts, tab
  // switches) are collapsed so the log stays readable.
  if (page === 1) {
    const checked = parseFilter(filter ?? null);
    const activeRules = checked.ok && checked.filter ? countActiveRules(checked.filter) : 0;
    const term = q?.trim() || null;
    if (activeRules > 0 || term) {
      const meta = JSON.stringify({ activeRules, q: term?.slice(0, 80) ?? null, scope: scope ?? "all", total: result.total });
      const recent = await db.activityLog.findFirst({
        where: { userId: session.userId, action: "search", meta, createdAt: { gt: new Date(Date.now() - 60_000) } },
        select: { id: true },
      });
      if (!recent) await db.activityLog.create({ data: { userId: session.userId, action: "search", meta } });
    }
  }

  const states = await db.userCompanyState.findMany({
    where: { userId: session.userId, companyId: { in: result.rows.map((r) => r.id) } },
  });
  const stateMap = new Map(states.map((s) => [s.companyId, s]));

  return NextResponse.json({
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      followed: stateMap.get(row.id)?.followed ?? false,
      trashed: stateMap.get(row.id)?.trashed ?? false,
    })),
  });
}
