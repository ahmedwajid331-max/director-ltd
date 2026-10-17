import type { Metadata } from "next";
import Link from "next/link";
import { FileSearch, Pencil, FilePlus2 } from "lucide-react";
import { PageHero, HeroChip, EmptyPanel } from "@/components/admin/AdminUi";
import { db } from "@/lib/db";
import { countRealCompanies } from "@/lib/data/companies";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";
import { autoRefreshState, autoRefreshText } from "@/lib/reports/autoRefresh";
import { ReportModeTabs } from "../ReportModeTabs";
import { ReportBuilderClient } from "./ReportBuilderClient";

export const metadata: Metadata = { title: "Report Builder" };

export default async function ReportBuilderPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { mode } = await searchParams;
  const editMode = mode === "edit";
  const session = await requirePermission("reports.create");
  const reports = editMode
    ? await db.report.findMany({ where: { ownerId: session.userId }, orderBy: { createdAt: "desc" } })
    : [];
  const [savedCount, refreshCount] = await Promise.all([
    db.report.count({ where: { ownerId: session.userId } }),
    db.report.count({ where: { ownerId: session.userId, dailyRefresh: true } }),
  ]);

  return (
    <div className="space-y-5">
      <PageHero
        icon={FilePlus2}
        accent="violet"
        eyebrow="Report builder"
        title="Reports"
        description="Combine any number of conditions to build the exact report you need. Save it once — results refresh daily."
      >
        <HeroChip label="Saved reports" value={savedCount.toLocaleString()} />
        <HeroChip label="Daily refresh on" value={refreshCount.toLocaleString()} dot={refreshCount > 0 ? "green" : undefined} />
      </PageHero>

      <ReportModeTabs active={editMode ? "edit" : "create"} />

      {!editMode && <ReportBuilderClient mode="create" totalCompanies={await countRealCompanies()} canCsv={can(session, "reports.exportCsv")} canDocs={can(session, "reports.exportDocs")} />}

      {editMode &&
        (reports.length === 0 ? (
          <EmptyPanel
            icon={FileSearch}
            tone="violet"
            title="No saved reports to edit yet"
            description="Create your first report and it will appear here."
          />
        ) : (
          <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[900px] text-left text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-100/70 text-[11px] uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Report</th>
                  <th className="px-3 py-2.5 font-semibold">Description</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Results</th>
                  <th className="px-3 py-2.5 font-semibold">Last automatic update</th>
                  <th className="px-3 py-2.5 font-semibold">Daily refresh</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reports.map((r) => (
                  <tr key={r.id} className="odd:bg-white even:bg-slate-50/40 hover:bg-indigo-50/50">
                    <td className="px-3 py-2.5 font-semibold text-slate-900">{r.name}</td>
                    <td className="max-w-xs truncate px-3 py-2.5 text-slate-500">{r.description ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.resultCount.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                      {autoRefreshText(autoRefreshState(r), formatDate)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={r.dailyRefresh ? "green" : "slate"}>{r.dailyRefresh ? "ON" : "OFF"}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-2">
                        <Link href={`/reports/${r.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                          View
                        </Link>
                        <Link href={`/reports/${r.id}/edit`} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700">
                          <Pencil className="h-3 w-3" /> Edit
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
    </div>
  );
}
