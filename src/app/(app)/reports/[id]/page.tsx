import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { formatDate } from "@/lib/data/format";
import { ReportResultsClient } from "./ReportResultsClient";

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();

  const report = await db.report.findUnique({ where: { id } });
  if (!report || (report.ownerId !== session.userId && session.role === "USER")) notFound();

  const filter = JSON.parse(report.filterJson);

  return (
    <div className="space-y-4">
      <Link href="/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 print:hidden">
        <ChevronLeft className="h-4 w-4" /> Back to reports
      </Link>

      <div>
        <h2 className="text-lg font-semibold text-slate-900">{report.name}</h2>
        {report.description && <p className="text-sm text-slate-500">{report.description}</p>}
        <p className="mt-1 text-xs text-slate-400">
          Last refreshed {formatDate(report.lastRunAt)} · {report.dailyRefresh ? "Refreshes daily" : "Manual refresh only"}
        </p>
      </div>

      <ReportResultsClient reportId={report.id} filter={filter} />
    </div>
  );
}
