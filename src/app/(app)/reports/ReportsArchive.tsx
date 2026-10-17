"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, RefreshCw, Eye, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/data/format";
import { autoRefreshState, autoRefreshText } from "@/lib/reports/autoRefresh";
import { ReportRowActions } from "./ReportRowActions";

export interface ArchiveReport {
  id: string;
  name: string;
  description: string | null;
  criteria: string;
  resultCount: number;
  dailyRefresh: boolean;
  lastRefreshError: string | null;
  createdAt: string;
  lastRunAt: string | null;
  // The scheduled job's last SUCCESSFUL refresh of this report (null = not yet).
  lastAutoRefreshAt: string | null;
}

type RefreshFilter = "all" | "on" | "off";

// Status is derived only from what the backend records: a failed refresh leaves lastRefreshError set.
function statusOf(r: ArchiveReport) {
  return r.lastRefreshError ? "ERROR" : "READY";
}

export function ReportsArchive({ reports, lastAutomaticUpdate }: { reports: ArchiveReport[]; lastAutomaticUpdate: string | null }) {
  const [q, setQ] = useState("");
  const [refresh, setRefresh] = useState<RefreshFilter>("all");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return reports.filter(
      (r) =>
        (refresh === "all" || (refresh === "on") === r.dailyRefresh) &&
        (!needle || r.name.toLowerCase().includes(needle) || (r.description ?? "").toLowerCase().includes(needle))
    );
  }, [reports, q, refresh]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search reports…"
              aria-label="Search reports"
              className="w-64 rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm focus-ring focus:border-indigo-400"
            />
          </div>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            Daily refresh
            <select
              value={refresh}
              onChange={(e) => setRefresh(e.target.value as RefreshFilter)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="all">All</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
        </div>
        <p className="text-xs text-slate-500">
          <span className="font-semibold text-slate-700" title="When the scheduled daily job last ran for the whole system. Each report's own last automatic update is in the table.">Daily update job last ran:</span>{" "}
          {lastAutomaticUpdate ? formatDate(lastAutomaticUpdate) : "has not run yet"}
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[960px] text-left text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-100/70 text-[11px] uppercase tracking-wide text-slate-600">
            <tr>
              <th className="w-10 px-3 py-2.5 text-right font-semibold text-slate-500">#</th>
              <th className="px-3 py-2.5 font-semibold">Report</th>
              <th className="px-3 py-2.5 font-semibold">Created</th>
              <th className="px-3 py-2.5 text-right font-semibold">Results</th>
              <th className="px-3 py-2.5 font-semibold">Daily refresh</th>
              <th className="px-3 py-2.5 font-semibold">Last automatic update</th>
              <th className="px-3 py-2.5 font-semibold">Status</th>
              <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r, i) => (
              <tr key={r.id} className="odd:bg-white even:bg-slate-50/40 hover:bg-indigo-50/50">
                <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400">{i + 1}</td>
                <td className="px-3 py-2.5">
                  <Link href={`/reports/${r.id}`} className="font-semibold text-indigo-700 hover:underline">
                    {r.name}
                  </Link>
                  {r.description && <p className="max-w-md truncate text-xs text-slate-500">{r.description}</p>}
                  <p className="max-w-md truncate text-[11px] text-slate-400" title={r.criteria}>
                    {r.criteria ? `Filters: ${r.criteria}` : "Filters: all companies"}
                  </p>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{formatDate(r.createdAt)}</td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">{r.resultCount.toLocaleString()}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={r.dailyRefresh ? "green" : "slate"}>{r.dailyRefresh ? "ON" : "OFF"}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                  {(() => {
                    const state = autoRefreshState(r);
                    return state.kind === "at" ? formatDate(state.at) : <span className="text-slate-400">{autoRefreshText(state, formatDate)}</span>;
                  })()}
                  {r.lastRunAt && <p className="text-[11px] text-slate-400">Results last computed {formatDate(r.lastRunAt)}</p>}
                </td>
                <td className="px-3 py-2.5">
                  <span title={r.lastRefreshError ?? "Last refresh succeeded"}>
                    <Badge tone={statusOf(r) === "ERROR" ? "red" : "green"}>{statusOf(r)}</Badge>
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <Link href={`/reports/${r.id}`} title="View report" aria-label="View report" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                      <Eye className="h-4 w-4" />
                    </Link>
                    <ReportRowActions reportId={r.id} />
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                  No reports match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="flex items-center gap-1.5 px-1 text-xs text-slate-400">
        <RefreshCw className="h-3 w-3" /> Reports with daily refresh ON are recomputed from live company data by the automatic daily update.
        <Pencil className="ml-2 h-3 w-3" /> Use the pencil to edit a report&apos;s criteria.
      </p>
    </div>
  );
}
