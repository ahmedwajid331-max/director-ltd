import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { logActivity } from "@/lib/activity";
import { filterAccessResponse } from "@/lib/auth/access";
import { buildCompanyWhere } from "@/lib/data/companies";
import { parseFilter } from "@/lib/filters/validate";
import { validateReportColumns, validateReportSort } from "@/lib/columns/store";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.viewOwn");
  if (denied) return denied;

  const reports = await db.report.findMany({
    where: { ownerId: session.userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ reports });
}

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  filter: z.unknown(),
  dailyRefresh: z.boolean().default(true),
  // Optional: the table columns and sort the report remembers.
  columns: z.array(z.string().max(60)).max(100).optional(),
  sort: z.object({ field: z.string().max(40), dir: z.string().max(4) }).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.create");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give the report a name." }, { status: 400 });

  const blocked = filterAccessResponse(session, parsed.data.filter);
  if (blocked) return blocked;

  const checked = parseFilter(parsed.data.filter);
  if (!checked.ok || !checked.filter) {
    return NextResponse.json({ error: "Invalid filter.", details: checked.ok ? ["filter is required"] : checked.errors.slice(0, 10) }, { status: 400 });
  }
  let columnsJson: string | null = null;
  let sortJson: string | null = null;
  if (parsed.data.columns) {
    const c = await validateReportColumns(parsed.data.columns);
    if (!c.ok) return NextResponse.json({ error: c.error }, { status: c.status });
    columnsJson = JSON.stringify(c.value);
  }
  if (parsed.data.sort) {
    const sv = validateReportSort(parsed.data.sort);
    if (!sv.ok) return NextResponse.json({ error: sv.error }, { status: sv.status });
    sortJson = JSON.stringify(sv.value);
  }
  const resultCount = await db.company.count({ where: buildCompanyWhere({ filter: checked.filter, userId: session.userId }) });

  const report = await db.report.create({
    data: {
      ownerId: session.userId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      filterJson: JSON.stringify(checked.filter),
      columnsJson,
      sortJson,
      dailyRefresh: parsed.data.dailyRefresh,
      resultCount,
      lastRunAt: new Date(),
    },
  });

  await logActivity(session, "report_created", { meta: { name: report.name }, reportId: report.id });

  return NextResponse.json({ report });
}
