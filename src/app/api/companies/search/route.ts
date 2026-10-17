import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { buildCompanyWhere, countUnknownDirectorMatches, isSortableField, searchCompanies } from "@/lib/data/companies";
import { withOfficerFreshness } from "@/lib/data/officer-coverage";
import { filterErrorResponse } from "@/lib/api/filter-errors";
import { parseFilter } from "@/lib/filters/validate";
import { countActiveRules } from "@/lib/filters/types";
import { can } from "@/lib/auth/permissions";
import { filterAccessResponse, redactDirectorFields } from "@/lib/auth/access";
import { logActivity } from "@/lib/activity";

const bodySchema = z.object({
  filter: z.unknown().optional(),
  q: z.string().max(200).optional(),
  namePrefix: z.string().regex(/^[A-Za-z]$/).optional(),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  sortField: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  scope: z.enum(["all", "followed", "saved", "redFlagged", "trashed"]).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "companies.view");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { filter, q, namePrefix, page, pageSize, sortField, sortDir, scope } = parsed.data;

  const blocked = filterAccessResponse(session, filter);
  if (blocked) return blocked;

  let where;
  try {
    // Default view excludes the user's trashed companies.
    where = buildCompanyWhere({ filter, q, namePrefix, scope: scope ?? "all", userId: session.userId });
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
      // Identical repeats within a minute (re-sorts, tab switches, the Report Builder's live count) collapse to one event.
      await logActivity(session, "search", { meta: { activeRules, q: term?.slice(0, 80) ?? null, scope: scope ?? "all", total: result.total }, dedupeMs: 60_000, dedupeSameMeta: true });
    }
  }

  const states = await db.userCompanyState.findMany({
    where: { userId: session.userId, companyId: { in: result.rows.map((r) => r.id) } },
  });
  const stateMap = new Map(states.map((s) => [s.companyId, s]));

  // Director filters only evaluate companies with confirmed officer data.
  // `unknown` = further companies that pass every non-director condition but
  // could not be evaluated (null when the filter has no director rule).
  const unknown = await countUnknownDirectorMatches({ filter, q, scope: scope ?? "all", userId: session.userId }, result.total);

  return NextResponse.json({
    ...result,
    officerCoverage: { hasDirectorRules: unknown !== null, confirmed: result.total, unknown: unknown ?? 0 },
    rows: withOfficerFreshness(result.rows).map((row) => ({
      ...(can(session, "companies.directors") ? row : redactDirectorFields(row)),
      followed: stateMap.get(row.id)?.followed ?? false,
      trashed: stateMap.get(row.id)?.trashed ?? false,
      saved: stateMap.get(row.id)?.saved ?? false,
      redFlagged: stateMap.get(row.id)?.redFlagged ?? false,
    })),
  });
}
