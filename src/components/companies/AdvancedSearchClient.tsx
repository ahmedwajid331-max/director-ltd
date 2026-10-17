"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookmarkPlus, ChevronDown, Columns3, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { ColumnPicker } from "@/components/columns/ColumnPicker";
import { BUILTIN_DEFAULT } from "@/lib/columns/resolve";
import { COMPANY_STATUS_OPTIONS, COMPANY_TYPE_OPTIONS } from "@/lib/filters/fields";
import { EMPTY_FORM, formToFilter, formToParams, hasCriteria, validateForm, type AdvancedForm } from "@/lib/filters/advancedSearch";
import type { SortableField } from "@/lib/data/companies";
import { cn } from "@/lib/cn";
import { ResultsTable, type CompanyRow } from "./ResultsTable";

const PAGE_SIZE = 25;
const INPUT = "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus-ring";

type SectionKey = "name" | "address" | "inc" | "status" | "sic" | "type" | "diss";
const ALL_SECTIONS: SectionKey[] = ["name", "address", "inc", "status", "sic", "type", "diss"];

// Companies House-style advanced search: a column of collapsible filter sections beside the results. Everything runs
// through the existing search API (database-level filtering, server-side pages), export and saved-report paths.
export function AdvancedSearchClient({
  initialForm,
  initialSearched,
  initialPage,
  initialColumns,
  columnsNotice = false,
}: {
  initialForm: AdvancedForm;
  initialSearched: boolean;
  initialPage: number;
  initialColumns?: string[];
  columnsNotice?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<AdvancedForm>(initialForm);
  // null = nothing searched yet. An applied search with no criteria means every company.
  const [applied, setApplied] = useState<AdvancedForm | null>(initialSearched || hasCriteria(initialForm) ? initialForm : null);
  const [page, setPage] = useState(initialPage);
  const [sortField, setSortField] = useState<SortableField>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [columns, setColumns] = useState<string[]>(initialColumns && initialColumns.length ? initialColumns : BUILTIN_DEFAULT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [open, setOpen] = useState<Set<SectionKey>>(() => {
    const s = new Set<SectionKey>();
    if (initialForm.name) s.add("name");
    if (initialForm.address || initialForm.postcode) s.add("address");
    if (initialForm.incFrom || initialForm.incTo) s.add("inc");
    if (initialForm.statuses.length) s.add("status");
    if (initialForm.sic) s.add("sic");
    if (initialForm.types.length) s.add("type");
    if (initialForm.dissFrom || initialForm.dissTo) s.add("diss");
    return s;
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const reqId = useRef(0);

  const run = useCallback(async () => {
    if (!applied) return;
    const id = ++reqId.current;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/companies/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: formToFilter(applied), page, pageSize: PAGE_SIZE, sortField, sortDir, scope: "all" }),
      });
      const data = await res.json().catch(() => ({}));
      if (id !== reqId.current) return;
      if (!res.ok) {
        setRows([]);
        setTotal(0);
        setFetchError(Array.isArray(data.details) && data.details.length ? data.details[0] : (data.error ?? "The search failed. Please try again."));
        return;
      }
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setPageCount(data.pageCount ?? 1);
    } catch {
      if (id === reqId.current) setFetchError("The search failed. Check your connection and try again.");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [applied, page, sortField, sortDir]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch whenever the applied search, page or sort changes
    void run();
  }, [run]);

  // The active search lives in the URL, so it survives paging, reloads and sharing the link.
  function pushUrl(form: AdvancedForm, p: number, searched: boolean) {
    const params = formToParams(form);
    if (searched) params.set("go", "1");
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    router.replace(qs ? `/companies/advanced?${qs}` : "/companies/advanced", { scroll: false });
  }

  function update() {
    const errs = validateForm(draft);
    setErrors(errs);
    if (errs.length) return;
    setApplied(draft);
    setPage(1);
    pushUrl(draft, 1, true);
  }

  function clear() {
    reqId.current++;
    setDraft(EMPTY_FORM);
    setApplied(null);
    setErrors([]);
    setRows([]);
    setTotal(0);
    setFetchError(null);
    setLoading(false);
    setPage(1);
    pushUrl(EMPTY_FORM, 1, false);
  }

  function changePage(p: number) {
    setPage(p);
    if (applied) pushUrl(applied, p, true);
  }

  function handleSort(field: SortableField, dir?: "asc" | "desc") {
    if (field === sortField) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir(dir ?? "asc");
    }
    setPage(1);
  }

  async function setState(id: string, patch: { followed?: boolean; trashed?: boolean; saved?: boolean; redFlagged?: boolean }) {
    // Trashing removes the row from these results; the other flags update it in place.
    setRows((prev) => (patch.trashed ? prev.filter((r) => r.id !== id) : prev.map((r) => (r.id === id ? { ...r, ...patch, ...(patch.followed ? { trashed: false } : {}) } : r))));
    const res = await fetch(`/api/companies/${id}/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    if (!res || !res.ok || patch.trashed) void run();
  }

  async function exportCsv() {
    if (!applied) return;
    setExporting(true);
    try {
      const res = await fetch("/api/companies/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: formToFilter(applied), scope: "all", columns }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        window.alert(data.error ?? "Export failed.");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `director-ltd-advanced-search-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  // Same hand-off the Companies page uses: the Report Builder picks the filter, columns and sort up from here.
  function saveAsReport() {
    if (!applied) return;
    sessionStorage.setItem("pendingReportFilter", JSON.stringify(formToFilter(applied)));
    sessionStorage.setItem("pendingReportQuery", "");
    sessionStorage.setItem("pendingReportColumns", JSON.stringify(columns));
    sessionStorage.setItem("pendingReportSort", JSON.stringify({ field: sortField, dir: sortDir }));
    router.push("/reports/new");
  }

  const toggle = (k: SectionKey) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  const set = <K extends keyof AdvancedForm>(k: K, v: AdvancedForm[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggleIn = (k: "statuses" | "types", v: string) => set(k, draft[k].includes(v) ? draft[k].filter((x) => x !== v) : [...draft[k], v]);
  const allOpen = open.size === ALL_SECTIONS.length;

  const section = (key: SectionKey, title: string, summary: string, body: React.ReactNode) => (
    <div className="border-t border-slate-200">
      <button type="button" onClick={() => toggle(key)} aria-expanded={open.has(key)} className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left focus-ring">
        <span className="text-sm font-semibold text-slate-900">
          {title}
          {summary && <span className="ml-2 text-xs font-normal text-indigo-700">{summary}</span>}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          {open.has(key) ? "Hide" : "Show"}
          <ChevronDown className={cn("h-4 w-4 transition-transform", open.has(key) && "rotate-180")} />
        </span>
      </button>
      {open.has(key) && <div className="space-y-2 px-4 pb-3">{body}</div>}
    </div>
  );
  const checkList = (name: "statuses" | "types", options: { value: string; label: string }[]) => (
    <div className="grid max-h-56 gap-1 overflow-y-auto">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={draft[name].includes(o.value)} onChange={() => toggleIn(name, o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
  const range = (fromKey: "incFrom" | "dissFrom", toKey: "incTo" | "dissTo", label: string) => (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs text-slate-500">
        {label} from
        <input type="date" value={draft[fromKey]} onChange={(e) => set(fromKey, e.target.value)} className={INPUT} />
      </label>
      <label className="text-xs text-slate-500">
        {label} to
        <input type="date" value={draft[toKey]} onChange={(e) => set(toKey, e.target.value)} className={INPUT} />
      </label>
    </div>
  );

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Advanced company search</h2>
        <p className="text-sm text-slate-500">Fill in one or more fields to search the companies in your database, then choose Update results.</p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update();
          }}
          className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
        >
          <div className="flex gap-2 px-4 py-3">
            <Button type="submit" size="sm">
              <Search className="h-4 w-4" /> Update results
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={clear}>
              Clear search
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(ALL_SECTIONS))}
            className="flex w-full items-center justify-end gap-1 px-4 pb-2 text-xs font-medium text-slate-600 hover:text-indigo-700"
          >
            {allOpen ? "Hide all filters" : "Show all filters"} <ChevronDown className={cn("h-4 w-4", allOpen && "rotate-180")} />
          </button>
          {errors.length > 0 && (
            <ul role="alert" className="mx-4 mb-2 space-y-0.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {section("name", "Company name", draft.name.trim(), <input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Name contains…" aria-label="Company name contains" className={INPUT} maxLength={200} />)}
          {section(
            "address",
            "Registered office address",
            [draft.address.trim(), draft.postcode.trim()].filter(Boolean).join(" · "),
            <>
              <label className="block text-xs text-slate-500">
                Enter a full or partial address
                <input value={draft.address} onChange={(e) => set("address", e.target.value)} placeholder="e.g. london" className={INPUT} maxLength={200} />
              </label>
              <label className="block text-xs text-slate-500">
                Postcode starts with
                <input value={draft.postcode} onChange={(e) => set("postcode", e.target.value)} placeholder="e.g. SW1A" className={INPUT} maxLength={20} />
              </label>
            </>
          )}
          {section("inc", "Incorporation date", [draft.incFrom, draft.incTo].filter(Boolean).join(" to "), range("incFrom", "incTo", "Incorporated"))}
          {section("status", "Company status", draft.statuses.length ? `${draft.statuses.length} selected` : "", checkList("statuses", COMPANY_STATUS_OPTIONS))}
          {section(
            "sic",
            "Nature of business",
            draft.sic.trim(),
            <label className="block text-xs text-slate-500">
              Standard Industrial Classification (SIC) codes, separated by commas
              <input value={draft.sic} onChange={(e) => set("sic", e.target.value)} placeholder="e.g. 68100, 68209" className={INPUT} maxLength={80} />
            </label>
          )}
          {section("type", "Company type", draft.types.length ? `${draft.types.length} selected` : "", checkList("types", COMPANY_TYPE_OPTIONS))}
          {section("diss", "Dissolved date", [draft.dissFrom, draft.dissTo].filter(Boolean).join(" to "), range("dissFrom", "dissTo", "Dissolved"))}
          <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-400">Company subtype is not stored in this database, so it is not offered.</div>
        </form>

        <div className="min-w-0 space-y-3">
          {!applied ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-500">
              Choose your filters and press <span className="font-medium text-slate-700">Update results</span>. With no filters, every company is returned.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p aria-live="polite" className="text-sm text-slate-600">
                  {fetchError ? (
                    <span className="text-red-600">{fetchError}</span>
                  ) : loading && rows.length === 0 ? (
                    "Searching…"
                  ) : (
                    <>
                      <span className="text-lg font-semibold text-slate-900">{total.toLocaleString()}</span> {total === 1 ? "result" : "results"}
                      {total > 0 && (
                        <span className="ml-2 text-slate-400">
                          showing {from.toLocaleString()}–{to.toLocaleString()}
                        </span>
                      )}
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen}>
                    <Columns3 className="h-4 w-4" /> Columns
                    {columnsNotice && <span className="ml-1 h-2 w-2 rounded-full bg-amber-500" aria-label="The recommended layout was updated" />}
                  </Button>
                  <Button variant="outline" size="sm" onClick={saveAsReport} title="Save this search as a report that refreshes daily">
                    <BookmarkPlus className="h-4 w-4" /> Save search
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting || total === 0}>
                    <Download className="h-4 w-4" /> {exporting ? "Exporting…" : "Export CSV"}
                  </Button>
                </div>
              </div>
              {pickerOpen && <ColumnPicker variant="panel" onApply={setColumns} onClose={() => setPickerOpen(false)} />}
              {!fetchError && (
                <div data-table className="space-y-2">
                  <ResultsTable
                    columns={columns}
                    rows={rows}
                    loading={loading}
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={handleSort}
                    onToggleFollow={(id, next) => void setState(id, { followed: next })}
                    onToggleTrash={(id, next) => void setState(id, { trashed: next })}
                    onToggleSaved={(id, next) => void setState(id, { saved: next })}
                    onToggleRedFlag={(id, next) => void setState(id, { redFlagged: next })}
                    startIndex={(page - 1) * PAGE_SIZE}
                    scope="all"
                  />
                  <Pagination page={page} pageCount={pageCount} total={total} pageSize={PAGE_SIZE} onPageChange={changePage} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
