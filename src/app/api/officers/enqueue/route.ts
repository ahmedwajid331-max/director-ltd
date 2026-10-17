import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { hasRole } from "@/lib/auth/guard";
import { buildCompanyWhere } from "@/lib/data/companies";
import { filterErrorResponse } from "@/lib/api/filter-errors";
import { enqueueOfficerJobs, loadOfficerConfig, OFFICER_PRIORITY } from "@/lib/companies-house/officerQueue";

const bodySchema = z.object({
  filter: z.unknown().optional(),
  q: z.string().max(200).optional(),
  scope: z.enum(["all", "followed", "saved", "redFlagged", "trashed"]).optional(),
  reportId: z.string().max(60).optional(),
});

// "Fetch officer data for these companies": QUEUES the companies a director
// filter could not evaluate (officer data not fetched yet). It never calls
// Companies House itself - the officer worker does that, within the shared
// quota - and it is capped per request so one filter cannot flood the queue.
// Companies whose officer data is "unavailable" are not queued: Companies
// House has none to fetch.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "companies.directors");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { filter, q, scope, reportId } = parsed.data;

  let priority: number = OFFICER_PRIORITY.FILTER;
  let reason = "filter";
  let effectiveFilter = filter;
  if (reportId) {
    const report = await db.report.findUnique({ where: { id: reportId } });
    if (!report || (report.ownerId !== session.userId && !hasRole(session, "ADMIN"))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    priority = OFFICER_PRIORITY.REPORT;
    reason = "report";
    effectiveFilter = JSON.parse(report.filterJson);
  }

  const cap = loadOfficerConfig().enqueueCap;
  let candidates: { id: string }[];
  try {
    const where = buildCompanyWhere({ filter: effectiveFilter, q, scope: scope ?? "all", userId: session.userId, mode: "possible" });
    candidates = await db.company.findMany({
      where: { AND: [where, { officersCoverage: "none" }] },
      select: { id: true },
      orderBy: { id: "asc" },
      take: cap + 1,
    });
  } catch (err) {
    const res = filterErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const result = await enqueueOfficerJobs(candidates.map((c) => c.id), { priority: priority as 1 | 3, reason, cap });
  await db.activityLog.create({
    data: { userId: session.userId, action: "officer_fetch_queued", meta: JSON.stringify({ reason, queued: result.inserted, upgraded: result.upgraded, truncated: result.truncated }) },
  });
  return NextResponse.json({ queued: result.inserted, alreadyQueued: result.upgraded, skipped: result.ineligible, truncated: result.truncated, cap });
}
