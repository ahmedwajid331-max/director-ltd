"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Printer, Share2, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { ResultsTable, type CompanyRow } from "@/components/companies/ResultsTable";
import type { SortableField } from "@/lib/data/companies";
import type { FilterGroupNode } from "@/lib/filters/types";

export function ReportResultsClient({ reportId, filter }: { reportId: string; filter: FilterGroupNode }) {
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortableField>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/reports/${reportId}?page=${page}&sortField=${sortField}&sortDir=${sortDir}`
      );
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setPageCount(data.pageCount ?? 1);
    } finally {
      setLoading(false);
    }
  }, [reportId, page, sortField, sortDir]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/param-change
    load();
  }, [load]);

  function handleSort(field: SortableField) {
    if (field === sortField) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir("asc");
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

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/companies/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `report-${reportId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  function handleShare() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2 print:hidden">
        <Button variant="outline" size="sm" onClick={handleShare}>
          {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
          {copied ? "Link copied" : "Share"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
          <Download className="h-4 w-4" /> {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      <ResultsTable
        rows={rows}
        loading={loading}
        sortField={sortField}
        sortDir={sortDir}
        onSort={handleSort}
        onToggleFollow={toggleFollow}
        onToggleTrash={toggleTrash}
        scope="all"
      />

      <div className="print:hidden">
        <Pagination page={page} pageCount={pageCount} total={total} pageSize={25} onPageChange={setPage} />
      </div>
    </div>
  );
}
