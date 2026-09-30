"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, SlidersHorizontal, Download, BookmarkPlus, X } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { FilterGroupEditor } from "@/components/filters/FilterGroup";
import { ResultsTable, type CompanyRow } from "./ResultsTable";
import { emptyFilterGroup, countActiveRules, type FilterGroupNode } from "@/lib/filters/types";
import type { SortableField } from "@/lib/data/companies";

const PAGE_SIZE = 25;

export function CompanyExplorer({
  scope = "all",
  title,
}: {
  scope?: "all" | "followed" | "trashed";
  title?: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterGroupNode>(emptyFilterGroup());
  const [q, setQ] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortableField>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/companies/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, q, page, pageSize: PAGE_SIZE, sortField, sortDir, scope }),
      });
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setPageCount(data.pageCount ?? 1);
    } finally {
      setLoading(false);
    }
  }, [filter, q, page, sortField, sortDir, scope]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runSearch, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [runSearch]);

  function handleFilterChange(next: FilterGroupNode) {
    setFilter(next);
    setPage(1);
  }

  function handleQueryChange(next: string) {
    setQ(next);
    setPage(1);
  }

  function handleSort(field: SortableField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  async function toggleFollow(id: string, next: boolean) {
    // A row only needs to disappear from view when it stops matching the
    // *current* scope's query (e.g. unfollowing on the Watches page).
    setRows((prev) =>
      scope === "followed" && !next
        ? prev.filter((r) => r.id !== id)
        : prev.map((r) => (r.id === id ? { ...r, followed: next } : r))
    );
    await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followed: next }),
    });
    if (scope === "followed") runSearch();
  }

  async function toggleTrash(id: string, next: boolean) {
    // "All companies" excludes trashed by default; the Trash page excludes
    // restored companies. Watches shows followed companies regardless of
    // trash state, so it doesn't remove the row either way.
    setRows((prev) =>
      (scope === "all" && next) || (scope === "trashed" && !next)
        ? prev.filter((r) => r.id !== id)
        : prev.map((r) => (r.id === id ? { ...r, trashed: next } : r))
    );
    await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: next }),
    });
    if (scope === "all" || scope === "trashed") runSearch();
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/companies/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, q, scope: scope === "followed" || scope === "trashed" ? scope : undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        window.alert(data.error ?? "Export failed.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `director-ltd-export-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  function handleSaveAsReport() {
    sessionStorage.setItem("pendingReportFilter", JSON.stringify(filter));
    sessionStorage.setItem("pendingReportQuery", q);
    router.push("/reports/new");
  }

  const activeRuleCount = countActiveRules(filter);

  return (
    <div className="space-y-4">
      {title && <h2 className="text-lg font-semibold text-slate-900">{title}</h2>}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={q}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search by name, number or postcode…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={showFilters ? "primary" : "outline"}
            size="sm"
            onClick={() => setShowFilters((s) => !s)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters {activeRuleCount > 0 && `(${activeRuleCount})`}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSaveAsReport}>
            <BookmarkPlus className="h-4 w-4" />
            Save as report
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="relative">
          <FilterGroupEditor group={filter} onChange={handleFilterChange} />
          {activeRuleCount > 0 && (
            <button
              onClick={() => handleFilterChange(emptyFilterGroup())}
              className="absolute -top-2 right-2 inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-500 shadow ring-1 ring-slate-200 hover:text-red-600"
            >
              <X className="h-3 w-3" /> Clear all
            </button>
          )}
        </div>
      )}

      <ResultsTable
        rows={rows}
        loading={loading}
        sortField={sortField}
        sortDir={sortDir}
        onSort={handleSort}
        onToggleFollow={toggleFollow}
        onToggleTrash={toggleTrash}
        scope={scope}
      />

      <Pagination page={page} pageCount={pageCount} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}
