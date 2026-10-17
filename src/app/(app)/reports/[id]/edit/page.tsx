import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { db } from "@/lib/db";
import { countRealCompanies } from "@/lib/data/companies";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { emptyFilterGroup, type FilterGroupNode } from "@/lib/filters/types";
import { ReportModeTabs } from "../../ReportModeTabs";
import { ReportBuilderClient } from "../../new/ReportBuilderClient";
import { loadReportColumns, parseReportSort } from "@/lib/columns/store";

export const metadata: Metadata = { title: "Edit Report" };

export default async function EditReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission("reports.edit");
  const report = await db.report.findUnique({ where: { id } });
  // Only the owner can edit (matches the PATCH route).
  if (!report || report.ownerId !== session.userId) notFound();

  let filter: FilterGroupNode = emptyFilterGroup();
  try {
    const parsed = JSON.parse(report.filterJson);
    if (parsed?.kind === "group") filter = parsed;
  } catch {
    /* fall back to an empty group; the user can rebuild the criteria */
  }

  const columns = await loadReportColumns(report.columnsJson);
  const sort = parseReportSort(report.sortJson);

  return (
    <div className="space-y-5">
      <Link href="/reports/new?mode=edit" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" /> Back to saved reports
      </Link>
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">Edit report</h2>
        <p className="text-sm text-slate-500">Editing &ldquo;{report.name}&rdquo;. Changes are saved to this same report.</p>
      </div>
      <ReportModeTabs active="edit" />
      <ReportBuilderClient
        mode="edit"
        totalCompanies={await countRealCompanies()}
        canCsv={can(session, "reports.exportCsv")}
        canDocs={can(session, "reports.exportDocs")}
        initial={{ id: report.id, name: report.name, description: report.description ?? "", filter, dailyRefresh: report.dailyRefresh, columns, sort }}
      />
    </div>
  );
}
