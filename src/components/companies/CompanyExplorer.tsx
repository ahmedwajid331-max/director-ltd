"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, SlidersHorizontal, Download, BookmarkPlus, X, Bookmark, Star, Flag, Trash2, RotateCcw, Columns3 } from "lucide-react";
import { ColumnPicker } from "@/components/columns/ColumnPicker";
import { BUILTIN_DEFAULT } from "@/lib/columns/resolve";
import { withSearchAsFilter } from "@/lib/filters/searchToFilter";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { FilterGroupEditor } from "@/components/filters/FilterGroup";
import { QuickFilters } from "@/components/filters/QuickFilters";
import { ResultsTable, type CompanyRow } from "./ResultsTable";
import { AlphabetBar } from "./AlphabetBar";
import { OfficerCoverageNotice, type OfficerCoverageSummary } from "./OfficerCoverageNotice";
import { emptyFilterGroup, countActiveRules, type FilterGroupNode } from "@/lib/filters/types";
import { describeRule, topLevelRules } from "@/lib/filters/describe";
import { formatDate } from "@/lib/data/format";
import type { SortableField } from "@/lib/data/companies";
import { cn } from "@/lib/cn";
import { useTypewriterPlaceholder } from "./useTypewriterPlaceholder";

const PAGE_SIZE = 25;

// "Sort by" menu: every entry is a real server-side sort.
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "name:asc", label: "Company name A → Z" },
  { value: "name:desc", label: "Company name Z → A" },
  { value: "companyNumber:asc", label: "Company number ascending" },
  { value: "companyNumber:desc", label: "Company number descending" },
  { value: "incorporationDate:desc", label: "Newest incorporated" },
  { value: "incorporationDate:asc", label: "Oldest incorporated" },
  { value: "status:asc", label: "Status A → Z" },
  { value: "status:desc", label: "Status Z → A" },
  { value: "type:asc", label: "Type A → Z" },
  { value: "type:desc", label: "Type Z → A" },
  { value: "filing:desc", label: "Filing: DS01 / late first" },
  { value: "filing:asc", label: "Filing: none first" },
  { value: "registeredCity:asc", label: "City / town A → Z" },
  { value: "registeredCity:desc", label: "City / town Z → A" },
  { value: "registeredPostcode:asc", label: "Postcode A → Z" },
  { value: "registeredPostcode:desc", label: "Postcode Z → A" },
  { value: "directorCount:desc", label: "Most directors" },
  { value: "directorCount:asc", label: "Fewest directors" },
  { value: "accountsNextDue:asc", label: "Accounts due soonest" },
];

export function CompanyExplorer({
  scope = "all",
  title,
  meta,
  initialQuery = "",
  initialColumns,
  columnsNotice = false,
}: {
  scope?: "all" | "followed" | "saved" | "redFlagged" | "trashed";
  title?: string;
  // Directory header data (company count, last data update) supplied by the server page.
  meta?: { total: number; lastUpdated: string | null };
  // Pre-fills the search box (the dashboard search sends people here with ?q=).
  initialQuery?: string;
  // The signed-in user's columns (their own saved list, or the recommended layout), resolved on the server.
  initialColumns?: string[];
  // True when the recommended layout changed after the user saved their own.
  columnsNotice?: boolean;
}) {
  const router = useRouter();
  const [columns, setColumns] = useState<string[]>(initialColumns && initialColumns.length ? initialColumns : BUILTIN_DEFAULT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState<FilterGroupNode>(emptyFilterGroup());
  const [q, setQ] = useState(initialQuery);
  const [letter, setLetter] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortableField>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<OfficerCoverageSummary | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Selection is by id and limited to the current page (never the full result set).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/companies/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, q, namePrefix: letter ?? undefined, page, pageSize: PAGE_SIZE, sortField, sortDir, scope }),
      });
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setCoverage(data.officerCoverage ?? null);
      setPageCount(data.pageCount ?? 1);
      // Selection never outlives the page it was made on.
      setSelectedIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [filter, q, letter, page, sortField, sortDir, scope]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runSearch, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [runSearch]);

  // Coming back to this page from the browser's back/forward cache restores the old rows without a request, so a company whose
  // officers were fetched on its detail page would still read "Not fetched". Re-run the search when the page is restored.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void runSearch();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [runSearch]);

  function handleFilterChange(next: FilterGroupNode) {
    setFilter(next);
    setPage(1);
  }

  function handleQueryChange(next: string) {
    setQ(next);
    setPage(1);
  }

  function handleLetterChange(next: string | null) {
    setLetter(next);
    setPage(1);
  }

  function handleSort(field: SortableField, dir?: "asc" | "desc") {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(dir ?? "asc");
    }
    // A new order starts from its first page (the Sort by menu already does this).
    setPage(1);
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
      ((scope === "all" || scope === "saved" || scope === "redFlagged") && next) || (scope === "trashed" && !next)
        ? prev.filter((r) => r.id !== id)
        : prev.map((r) => (r.id === id ? { ...r, trashed: next } : r))
    );
    await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: next }),
    });
    if (scope === "all" || scope === "saved" || scope === "redFlagged" || scope === "trashed") runSearch();
  }

  // Saved and Red Flag are independent per-user flags: they never move a row out of the current view.
  async function toggleFlag(id: string, key: "saved" | "redFlagged", next: boolean) {
    // In the Saved / Red flags views, clearing that flag means the row no longer belongs there.
    const leaves = !next && ((scope === "saved" && key === "saved") || (scope === "redFlagged" && key === "redFlagged"));
    setRows((prev) => (leaves ? prev.filter((r) => r.id !== id) : prev.map((r) => (r.id === id ? { ...r, [key]: next } : r))));
    const res = await fetch(`/api/companies/${id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: next }),
    }).catch(() => null);
    if (!res || !res.ok) runSearch();
    else if (leaves) runSearch();
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function selectAllOnPage() {
    setSelectedIds(new Set(rows.map((r) => r.id)));
  }

  function togglePageSelection() {
    if (rows.length > 0 && rows.every((r) => selectedIds.has(r.id))) setSelectedIds(new Set());
    else selectAllOnPage();
  }

  async function bulkUpdate(patch: { saved?: boolean; followed?: boolean; redFlagged?: boolean; trashed?: boolean }) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await fetch("/api/companies/bulk-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, patch }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setBulkError(data.error ?? "Could not update the selected companies.");
        return;
      }
      const chosen = new Set(ids);
      // Mirror the server's rule: trashing un-follows, following restores.
      const applied = { ...patch };
      if (applied.trashed === true) applied.followed = false;
      if (applied.followed === true) applied.trashed = false;
      const leavesView =
        (scope === "all" && applied.trashed === true) ||
        (scope === "trashed" && applied.trashed === false) ||
        (scope === "followed" && applied.followed === false) ||
        (scope === "saved" && (applied.saved === false || applied.trashed === true)) ||
        (scope === "redFlagged" && (applied.redFlagged === false || applied.trashed === true)) ||
        ((scope === "saved" || scope === "redFlagged") && applied.trashed === true);
      setRows((prev) =>
        prev.filter((r) => !(leavesView && chosen.has(r.id))).map((r) => (chosen.has(r.id) ? { ...r, ...applied } : r))
      );
      setSelectedIds(new Set());
      runSearch();
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/companies/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, q, namePrefix: letter ?? undefined, scope, columns }),
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
    // The search box and A-Z letter are not part of the filter tree, so they are converted into equivalent rules; the
    // saved report then matches exactly what is on screen. The table's columns and sort are remembered too.
    sessionStorage.setItem("pendingReportFilter", JSON.stringify(withSearchAsFilter(filter, q, letter)));
    sessionStorage.setItem("pendingReportQuery", q);
    sessionStorage.setItem("pendingReportColumns", JSON.stringify(columns));
    sessionStorage.setItem("pendingReportSort", JSON.stringify({ field: sortField, dir: sortDir }));
    router.push("/reports/new");
  }

  const activeRuleCount = countActiveRules(filter);
  const selectedRows = rows.filter((r) => selectedIds.has(r.id));
  const isDirectory = scope === "all";
  const chips = topLevelRules(filter);
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  const sortValue = `${sortField}:${sortDir}`;

  const [searchFocused, setSearchFocused] = useState(false);
  const typed = useTypewriterPlaceholder(isDirectory && !searchFocused && !q);
  const showTyped = typed.animating && !q && !searchFocused;
  const searchBox = (
    <div className={cn("relative w-full", isDirectory ? "max-w-3xl" : "mx-auto max-w-3xl")}>
      <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
      <input
        value={q}
        onChange={(e) => handleQueryChange(e.target.value)}
        onFocus={() => setSearchFocused(true)}
        onBlur={() => setSearchFocused(false)}
        placeholder={showTyped ? "" : "Search UK companies by name, company number or postcode…"}
        aria-label="Search UK companies by name, company number or postcode"
        className={cn(
          "h-14 w-full rounded-full bg-white pl-13 pr-12 text-base text-slate-900 outline-none placeholder:text-slate-400",
          isDirectory
            ? "border-0 shadow-xl shadow-indigo-950/30 ring-4 ring-white/10 focus:ring-white/30"
            : "border border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100"
        )}
        style={{ paddingLeft: "3.25rem" }}
      />
      {showTyped && (
        <span aria-hidden className="pointer-events-none absolute left-[3.25rem] right-12 top-1/2 -translate-y-1/2 truncate text-base text-slate-400">
          {typed.text}
          <span className="ml-px inline-block h-5 w-px translate-y-1 animate-pulse bg-slate-400" />
        </span>
      )}
      {q && (
        <button onClick={() => handleQueryChange("")} aria-label="Clear search" className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {isDirectory ? (
        <header
          className="relative overflow-hidden rounded-2xl px-6 py-8 text-white shadow-lg shadow-indigo-950/20 sm:px-10 sm:py-10"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(135deg, var(--color-indigo-950), var(--color-indigo-900) 55%, var(--color-indigo-700))",
            backgroundSize: "36px 36px, 36px 36px, auto",
          }}
        >
          {/* abstract data-network accent: decorative only (same motif as the Dashboard hero) */}
          <svg aria-hidden className="pointer-events-none absolute -right-10 -top-16 hidden h-[26rem] w-[26rem] text-white/10 lg:block" viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="1.2">
            <circle cx="200" cy="200" r="190" />
            <circle cx="200" cy="200" r="140" />
            <circle cx="200" cy="200" r="90" />
            <path d="M200 10v380M10 200h380M65 65l270 270M335 65L65 335" strokeOpacity=".5" />
            <g fill="currentColor" stroke="none">
              <circle cx="200" cy="10" r="5" />
              <circle cx="335" cy="65" r="5" />
              <circle cx="390" cy="200" r="5" />
              <circle cx="140" cy="200" r="4" />
              <circle cx="290" cy="290" r="4" />
            </g>
          </svg>
          <div className="relative space-y-4">
            <nav aria-label="Breadcrumb" className="text-xs text-indigo-200">
              <a href="/dashboard" className="hover:text-white">Home</a> <span className="mx-1">/</span> <span className="text-white">UK companies</span>
            </nav>
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-indigo-100 ring-1 ring-white/15">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> United Kingdom company database
              </span>
              <h2 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Search UK companies</h2>
              <p className="mt-2 max-w-2xl text-[15px] text-indigo-100">
                Every company on the Companies House register, searchable by name, number or postcode, filterable by status, age, location, filings and directors, and kept
                current by live filing updates.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {[
                ["Source", "Companies House"],
                ["Registration ID", "Company number"],
                ["Companies", meta ? meta.total.toLocaleString() : "—"],
                ["Last updated", meta?.lastUpdated ? formatDate(meta.lastUpdated) : "—"],
              ].map(([k, v]) => (
                <span key={k} className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-200 ring-1 ring-white/10">
                  {k}: <span className="font-semibold text-white">{v}</span>
                </span>
              ))}
            </div>
            <div className="pt-2">{searchBox}</div>
          </div>
        </header>
      ) : (
        <>
          {title && <h2 className="text-lg font-semibold text-slate-900">{title}</h2>}
          {searchBox}
        </>
      )}

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="px-4 pb-3 pt-4">
          <QuickFilters filter={filter} onChange={handleFilterChange} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.length === 0 && <span className="text-xs text-slate-400">No filters applied: showing every UK company.</span>}
            {chips.map((rule) => (
              <span key={rule.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs text-slate-700 ring-1 ring-slate-200">
                {describeRule(rule)}
                <button
                  onClick={() => handleFilterChange({ ...filter, children: filter.children.filter((c) => c.id !== rule.id) })}
                  aria-label="Remove filter"
                  className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {activeRuleCount > 0 && (
              <button onClick={() => handleFilterChange(emptyFilterGroup())} className="px-1 text-xs font-medium text-slate-500 hover:text-red-600">
                Clear all
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800 hover:text-indigo-700"
          >
            <SlidersHorizontal className="h-4 w-4 text-indigo-600" />
            Advanced filters (AND / OR)
            <span className="text-xs font-normal text-slate-400">{showFilters ? "Hide" : "Show"}</span>
          </button>
        </div>
        {showFilters && (
          <div className="border-t border-slate-100 bg-slate-50/50 p-4">
            <FilterGroupEditor group={filter} onChange={handleFilterChange} />
            <p className="mt-2 text-xs text-slate-400">
              Combine conditions with ALL (AND) / ANY (OR) and nest groups for logic such as (Dormant AND Active) OR DS01. Save any result as a report from the button below.
            </p>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Showing{" "}
          <span className="font-semibold text-slate-900">
            {loading && rows.length === 0 ? "…" : `${from.toLocaleString()}–${to.toLocaleString()}`}
          </span>{" "}
          of <span className="font-semibold text-slate-900">{loading && rows.length === 0 ? "…" : total.toLocaleString()}</span> {total === 1 ? "company" : "companies"}
          {letter && (
            <button
              type="button"
              onClick={() => handleLetterChange(null)}
              className="ml-2 inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100"
              title="Clear the letter filter"
            >
              Name starts with {letter} <X className="h-3 w-3" />
            </button>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
            Sort by
            <select
              value={sortValue}
              onChange={(e) => {
                const [f, d] = e.target.value.split(":") as [SortableField, "asc" | "desc"];
                setSortField(f);
                setSortDir(d);
                setPage(1);
              }}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus-ring"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen} title="Choose which columns the table shows">
            <Columns3 className="h-4 w-4" />
            Columns
            {columnsNotice && <span className="ml-1 h-2 w-2 rounded-full bg-amber-500" aria-label="The recommended layout was updated" />}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSaveAsReport} title="Turn the current search and filters into a saved report that refreshes daily">
            <BookmarkPlus className="h-4 w-4" />
            Save as report
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} title="Downloads the current search, filters and letter as CSV">
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <AlphabetBar value={letter} onChange={handleLetterChange} />
      </div>

      <OfficerCoverageNotice summary={coverage} request={{ filter, q, scope }} />

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-4 py-2 text-sm">
          <span className="font-medium text-slate-700">{selectedIds.size} selected</span>
          <Button variant="outline" size="sm" onClick={selectAllOnPage} disabled={bulkBusy || selectedIds.size === rows.length}>
            Select all
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())} disabled={bulkBusy}>
            Deselect all
          </Button>
          <span className="mx-1 h-5 w-px bg-slate-200" />
          <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => bulkUpdate({ saved: !selectedRows.every((r) => r.saved) })}>
            <Bookmark className="h-4 w-4" />
            {selectedRows.every((r) => r.saved) ? "Unsave" : "Save company"}
          </Button>
          <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => bulkUpdate({ followed: !selectedRows.every((r) => r.followed) })}>
            <Star className="h-4 w-4" />
            {selectedRows.every((r) => r.followed) ? "Unfollow" : "Follow"}
          </Button>
          <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => bulkUpdate({ redFlagged: !selectedRows.every((r) => r.redFlagged) })}>
            <Flag className="h-4 w-4" />
            {selectedRows.every((r) => r.redFlagged) ? "Remove red flag" : "Red flag"}
          </Button>
          {scope === "trashed" ? (
            <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => bulkUpdate({ trashed: false })}>
              <RotateCcw className="h-4 w-4" /> Restore
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => bulkUpdate({ trashed: true })}>
              <Trash2 className="h-4 w-4" /> Move to Trash
            </Button>
          )}
          {bulkError && <span className="text-red-600">{bulkError}</span>}
        </div>
      )}

      {pickerOpen && <ColumnPicker variant="panel" onApply={setColumns} onClose={() => setPickerOpen(false)} />}

      <div data-table className="space-y-4">
      <ResultsTable
        columns={columns}
        rows={rows}
        loading={loading}
        sortField={sortField}
        sortDir={sortDir}
        onSort={handleSort}
        onToggleFollow={toggleFollow}
        onToggleTrash={toggleTrash}
        onToggleSaved={(id, next) => toggleFlag(id, "saved", next)}
        onToggleRedFlag={(id, next) => toggleFlag(id, "redFlagged", next)}
        startIndex={(page - 1) * PAGE_SIZE}
        scope={scope}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onTogglePageSelection={togglePageSelection}
      />

      <Pagination page={page} pageCount={pageCount} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      {isDirectory && (
        <p className="px-1 text-xs text-slate-400">
          Source: Companies House register, kept current by live filing updates{meta?.lastUpdated ? ` (updated ${formatDate(meta.lastUpdated)})` : ""}.
        </p>
      )}
      </div>
    </div>
  );
}
