import type { Metadata } from "next";
import Link from "next/link";
import { FileSearch, Plus } from "lucide-react";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate } from "@/lib/data/format";
import { ReportRowActions } from "./ReportRowActions";

export const metadata: Metadata = { title: "Saved Reports" };

export default async function ReportsPage() {
  const session = await requireSession();
  const reports = await db.report.findMany({
    where: { ownerId: session.userId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Saved reports</h2>
          <p className="text-sm text-slate-500">Reports refresh automatically every day.</p>
        </div>
        <LinkButton href="/reports/new" size="sm">
          <Plus className="h-4 w-4" /> New report
        </LinkButton>
      </div>

      {reports.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title="No saved reports yet"
          description="Build a filter in the report builder and save it to see it here."
          action={
            <LinkButton href="/reports/new" size="sm">
              Build a report
            </LinkButton>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Results</th>
                <th className="px-4 py-3 font-medium">Last refreshed</th>
                <th className="px-4 py-3 font-medium">Daily refresh</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reports.map((report) => (
                <tr key={report.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <Link href={`/reports/${report.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                      {report.name}
                    </Link>
                    {report.description && <p className="text-xs text-slate-500">{report.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{report.resultCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(report.lastRunAt)}</td>
                  <td className="px-4 py-3 text-slate-600">{report.dailyRefresh ? "Yes" : "No"}</td>
                  <td className="px-4 py-3">
                    <ReportRowActions reportId={report.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
