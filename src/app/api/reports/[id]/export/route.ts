import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { denyUnless } from "@/lib/auth/require";
import { parseReportSort } from "@/lib/columns/store";
import { exportReportDocument } from "@/lib/reports/exportDocument";
import { can } from "@/lib/auth/permissions";

// PDF / Word download of a SAVED report: the report's own filter, saved columns and the sort on screen. Same access rule
// as viewing the report (owner, or an admin). The row ceilings, narrowing rule, columns and activity log live in the
// shared implementation (lib/reports/exportDocument.ts), which the Report Builder's unsaved export uses too.
// Reports above the document ceiling are refused with a message - never truncated.
// CSV keeps using /api/companies/export (streaming) unchanged.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyUnless(session, "reports.exportDocs");
  if (denied) return denied;

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id } });
  if (!report || (report.ownerId !== session.userId && !can(session, "reports.viewOthers"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sp = new URL(request.url).searchParams;
  const format = sp.get("format");
  if (format !== "pdf" && format !== "docx") return NextResponse.json({ error: "Unsupported format." }, { status: 400 });

  let rawFilter: unknown = null;
  try {
    rawFilter = JSON.parse(report.filterJson);
  } catch {
    return NextResponse.json({ error: "This report's saved conditions could not be read." }, { status: 422 });
  }
  const savedCols = (() => {
    try {
      const v = JSON.parse(report.columnsJson ?? "null");
      return Array.isArray(v) ? (v as string[]) : null;
    } catch {
      return null;
    }
  })();

  return exportReportDocument(session, {
    format,
    rawFilter,
    ownerId: report.ownerId,
    savedColumns: savedCols,
    savedSort: parseReportSort(report.sortJson),
    requestedSortField: sp.get("sortField"),
    requestedSortDir: sp.get("sortDir"),
    title: report.name,
    description: report.description,
    subject: "This report",
    activity: { meta: { name: report.name }, reportId: report.id },
  });
}
