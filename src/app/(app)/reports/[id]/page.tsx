import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Pencil } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/data/format";
import { autoRefreshState, autoRefreshText } from "@/lib/reports/autoRefresh";
import { ReportResultsClient } from "./ReportResultsClient";
import { loadReportColumns, parseReportSort } from "@/lib/columns/store";

export default async function ReportDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { id } = await params;
  const { saved } = await searchParams;
  const session = await requirePermission("reports.viewOwn");

  const report = await db.report.findUnique({ where: { id } });
  if (!report || (report.ownerId !== session.userId && !can(session, "reports.viewOthers"))) notFound();

  const filter = JSON.parse(report.filterJson);
  // lastRunAt is written by creation, edits, the manual Refresh button AND the daily job; the scheduled job's own
  // success for THIS report is lastAutoRefreshAt.
  const autoRefresh = autoRefreshState(report);

  return (
    <div className="space-y-4">
      <Link href="/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 print:hidden">
        <ChevronLeft className="h-4 w-4" /> Back to reports
      </Link>

      {saved && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 print:hidden">
          {saved === "updated" ? "Report updated successfully." : "Report saved successfully."} It now appears in your report archive.
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{report.name}</h2>
        {report.description && <p className="text-sm text-slate-500">{report.description}</p>}
        <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-xs">
          <div>
            <dt className="text-slate-400">Daily refresh</dt>
            <dd className={report.dailyRefresh ? "font-semibold text-emerald-700" : "font-semibold text-slate-500"}>{report.dailyRefresh ? "ON" : "OFF"}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Last automatic daily update</dt>
            <dd className="font-medium text-slate-700">
              {autoRefreshText(autoRefresh, formatDate)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Results last computed</dt>
            <dd className="font-medium text-slate-700">{formatDate(report.lastRunAt)}</dd>
          </div>
        </dl>
        {report.dailyRefresh && (
          <p className="mt-1 text-xs text-slate-400">This report automatically updates from the live company data every day.</p>
        )}
      </div>
        {report.ownerId === session.userId && can(session, "reports.edit") && (
          <LinkButton href={`/reports/${report.id}/edit`} size="sm" variant="outline" className="print:hidden">
            <Pencil className="h-4 w-4" /> Edit report
          </LinkButton>
        )}
      </div>

      <ReportResultsClient reportId={report.id} reportName={report.name} filter={filter} columns={await loadReportColumns(report.columnsJson)} initialSort={parseReportSort(report.sortJson)} canShare={can(session, "reports.share")} canCsv={can(session, "reports.exportCsv")} canDocs={can(session, "reports.exportDocs")} />
    </div>
  );
}
