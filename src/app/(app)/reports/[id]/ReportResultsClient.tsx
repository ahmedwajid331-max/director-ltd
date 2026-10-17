"use client";

import { useCallback, useEffect, useState } from "react";
import { Pagination } from "@/components/ui/Pagination";
import { ResultsTable, type CompanyRow } from "@/components/companies/ResultsTable";
import { OfficerCoverageNotice, type OfficerCoverageSummary } from "@/components/companies/OfficerCoverageNotice";
import type { SortableField } from "@/lib/data/companies";
import type { FilterGroupNode } from "@/lib/filters/types";
import { ReportActionMenus } from "./ReportActionMenus";

export function ReportResultsClient({
  reportId,
  reportName,
  filter,
  columns,
  initialSort,
  canShare,
  canCsv,
  canDocs,
}: {
  reportId: string;
  reportName: string;
  filter: FilterGroupNode;
  // The columns and sort this report remembered. null = saved before they were remembered: the original table.
  columns?: string[] | null;
  initialSort?: { field: SortableField; dir: "asc" | "desc" } | null;
  canShare?: boolean;
  canCsv?: boolean;
  canDocs?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortableField>(initialSort?.field ?? "name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSort?.dir ?? "asc");
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<OfficerCoverageSummary | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/reports/${reportId}?page=${page}&sortField=${sortField}&sortDir=${sortDir}`
      );
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setCoverage(data.officerCoverage ?? null);
      setPageCount(data.pageCount ?? 1);
    } finally {
      setLoading(false);
    }
  }, [reportId, page, sortField, sortDir]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/param-change
    load();
  }, [load]);

  function handleSort(field: SortableField, dir?: "asc" | "desc") {
    if (field === sortField) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir(dir ?? "asc");
    }
  }

  async function toggleFollow(id: string, next: boolean) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, followed: next } : r)));
    await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followed: next }),
    });
  }

  async function toggleTrash(id: string, next: boolean) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, trashed: next } : r)));
    await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: next }),
    });
  }

  async function toggleFlag(id: string, key: "saved" | "redFlagged", next: boolean) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: next } : r)));
    const res = await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: next }),
    }).catch(() => null);
    if (!res || !res.ok) setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: !next } : r)));
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ReportActionMenus reportId={reportId} reportName={reportName} filter={filter} columns={columns} sortField={sortField} sortDir={sortDir} total={loading ? null : total} canShare={canShare} canCsv={canCsv} canDocs={canDocs} />
      </div>

      <p className="text-sm text-slate-600">
        <span className="text-base font-semibold text-slate-900">{total.toLocaleString()}</span> {total === 1 ? "company" : "companies"} in this report
      </p>

      <OfficerCoverageNotice summary={coverage} request={{ reportId }} />

      <ResultsTable
        rows={rows}
        loading={loading}
        sortField={sortField}
        sortDir={sortDir}
        onSort={handleSort}
        onToggleFollow={toggleFollow}
        onToggleTrash={toggleTrash}
        onToggleSaved={(id, next) => toggleFlag(id, "saved", next)}
        onToggleRedFlag={(id, next) => toggleFlag(id, "redFlagged", next)}
        startIndex={(page - 1) * 25}
        scope="all"
        columns={columns ?? undefined}
      />

      <div className="print:hidden">
        <Pagination page={page} pageCount={pageCount} total={total} pageSize={25} onPageChange={setPage} />
      </div>
    </div>
  );
}
