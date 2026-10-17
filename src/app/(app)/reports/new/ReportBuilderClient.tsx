"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Save, Eye, EyeOff, Loader2, X, ChevronRight } from "lucide-react";
import { FilterGroupEditor } from "@/components/filters/FilterGroup";
import { CriteriaPanel } from "@/components/filters/CriteriaPanel";
import { ResultsTable, type CompanyRow } from "@/components/companies/ResultsTable";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { emptyFilterGroup, countActiveRules, type FilterGroupNode } from "@/lib/filters/types";
import type { SortableField } from "@/lib/data/companies";
import { describeFilter } from "@/lib/filters/describe";
import { removeTopLevel } from "@/lib/filters/criteria";
import { cn } from "@/lib/cn";
import { BuilderExportMenu, type ExportNotice } from "./BuilderExportMenu";

export interface ReportInitial {
  id: string;
  name: string;
  description: string;
  filter: FilterGroupNode;
  dailyRefresh: boolean;
  // What the report remembered when it was saved (null/absent for reports saved before columns were remembered).
  columns?: string[] | null;
  sort?: { field: SortableField; dir: "asc" | "desc" } | null;
}

const PREVIEW_ROWS = 10;

// One builder for both workflows. mode="create" POSTs a new report; mode="edit"
// PATCHes the existing report in place (same id), so saved reports are never duplicated.
export function ReportBuilderClient({ mode = "create", initial, totalCompanies, canCsv = true, canDocs = true }: { mode?: "create" | "edit"; initial?: ReportInitial; totalCompanies?: number; canCsv?: boolean; canDocs?: boolean }) {
  const router = useRouter();
  const editing = mode === "edit" && !!initial;
  const [filter, setFilter] = useState<FilterGroupNode>(initial?.filter ?? emptyFilterGroup());
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [dailyRefresh, setDailyRefresh] = useState(initial?.dailyRefresh ?? true);
  // Matching-company count: "loading" until the first answer for the CURRENT conditions arrives, never a stale number.
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [countState, setCountState] = useState<"loading" | "ready" | "error">("loading");
  const [countError, setCountError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewRows, setPreviewRows] = useState<CompanyRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sort, setSort] = useState<{ field: SortableField; dir: "asc" | "desc" }>(initial?.sort ?? { field: "name", dir: "asc" });
  // Saved with the report only when it was carried over or deliberately chosen; otherwise the report keeps its default.
  const [rememberSort, setRememberSort] = useState(!!initial?.sort);
  const [columns, setColumns] = useState<string[] | null>(initial?.columns ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Result of the last export. Exporting never saves a report, so this is its own message, separate from Save errors.
  const [exportNotice, setExportNotice] = useState<ExportNotice>(null);
  // Collapsed by default for a new report; opens automatically when conditions already exist (edit, or carried over from Companies).
  const [advOpen, setAdvOpen] = useState((initial?.filter.children.length ?? 0) > 0);

  useEffect(() => {
    if (editing) return;
    const pending = sessionStorage.getItem("pendingReportFilter");
    if (pending) {
      try {
        const parsed = JSON.parse(pending);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from sessionStorage on mount
        setFilter(parsed);
        if (parsed?.children?.length) setAdvOpen(true);
      } catch {
        /* ignore malformed sessionStorage payload */
      }
      try {
        const cols = JSON.parse(sessionStorage.getItem("pendingReportColumns") ?? "null");
        if (Array.isArray(cols)) setColumns(cols);
        const srt = JSON.parse(sessionStorage.getItem("pendingReportSort") ?? "null");
        if (srt && typeof srt.field === "string" && (srt.dir === "asc" || srt.dir === "desc")) {
          setSort({ field: srt.field, dir: srt.dir });
          setRememberSort(true);
        }
      } catch {
        /* ignore malformed sessionStorage payload */
      }
      sessionStorage.removeItem("pendingReportFilter");
      sessionStorage.removeItem("pendingReportQuery");
      sessionStorage.removeItem("pendingReportColumns");
      sessionStorage.removeItem("pendingReportSort");
    }
  }, [editing]);

  // Live count and (optional) preview both use the existing /api/companies/search - the same buildCompanyWhere as
  // saved results and CSV export, so there is no second filter engine. Debounced, and superseded requests are aborted.
  useEffect(() => {
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conditions changed: drop the old number immediately
    setCountState("loading");
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/companies/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            filter,
            page: 1,
            pageSize: showPreview ? PREVIEW_ROWS : 1,
            sortField: sort.field,
            sortDir: sort.dir,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (ctrl.signal.aborted) return;
        if (!res.ok || typeof data.total !== "number") {
          setCountError(data.error ?? "The matching count could not be calculated. Try again.");
          setCountState("error");
          setPreviewCount(null);
          setPreviewRows([]);
        } else {
          setCountError(null);
          setPreviewCount(data.total);
          setPreviewRows(showPreview ? (data.rows ?? []) : []);
          setCountState("ready");
        }
        setPreviewLoading(false);
      } catch {
        if (ctrl.signal.aborted) return;
        setCountError("The matching count could not be calculated. Check your connection and try again.");
        setCountState("error");
        setPreviewCount(null);
        setPreviewLoading(false);
      }
    }, 400);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [filter, showPreview, sort]);

  async function handleSave() {
    if (!name.trim()) {
      setError("Give the report a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/reports/${initial!.id}` : "/api/reports", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), filter, dailyRefresh, ...(columns ? { columns } : {}), ...(rememberSort ? { sort } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save the report.");
        return;
      }
      router.push(`/reports/${data.report.id}?saved=${editing ? "updated" : "created"}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const rules = countActiveRules(filter);
  const chips = filter.children
    .map((c) => ({ id: c.id, text: describeFilter(c, false) }))
    .filter((c) => c.text);
  const isAll = filter.combinator === "AND";

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-xs text-white">1</span>
            Report details
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">{editing ? "Editing saved report" : "New report"}</span>
          </h3>
          <div className="grid items-end gap-3 lg:grid-cols-[1fr_1fr_auto]">
            <div>
              <Label>Report name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dormant companies with DS01 filed" />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short note for your team" />
            </div>
            <label
              className={cn(
                "flex h-[38px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px]",
                dailyRefresh ? "border-indigo-300 bg-indigo-50 text-indigo-900" : "border-slate-200 text-slate-600"
              )}
            >
              <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={dailyRefresh} onChange={(e) => setDailyRefresh(e.target.checked)} />
              Refresh results daily
              </label>
          </div>
        </section>

        <section
          className={cn(
            "sticky top-2 z-10 rounded-xl border p-4 shadow-sm",
            countState === "error" ? "border-red-200 bg-red-50" : "border-indigo-200 bg-indigo-50"
          )}
          aria-live="polite"
          data-testid="matching-companies"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Matching companies</p>
          {countState === "error" ? (
            <p className="mt-1 text-sm text-red-700" data-testid="matching-count-error">{countError}</p>
          ) : countState === "loading" ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-indigo-800" data-testid="matching-count-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> Counting matching companies…
            </p>
          ) : (
            <>
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-3xl font-semibold tabular-nums text-slate-900" data-testid="matching-count">{previewCount?.toLocaleString()}</span>
                <span className="text-sm text-slate-700">
                  {rules === 0 ? "companies (no conditions applied)" : previewCount === 1 ? "company matches your conditions" : "companies match your conditions"}
                </span>
                {totalCompanies !== undefined && (
                  <span className="text-sm text-slate-500" data-testid="database-total">
                    · of {totalCompanies.toLocaleString()} companies in the database
                  </span>
                )}
              </p>
              {previewCount === 0 && rules > 0 && (
                <p className="mt-1 text-xs text-amber-700">No companies match these conditions. Try removing a condition{isAll ? " or switching ALL (AND) to ANY (OR)" : ""}.</p>
              )}
            </>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 shadow-sm">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-xs text-white">2</span>
                Choose your criteria
              </h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
              Match
              <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 bg-white" role="group" aria-label="How the criteria combine">
                {(
                  [
                    { c: "AND", label: "ALL", hint: "Every condition must be true (AND)" },
                    { c: "OR", label: "ANY", hint: "At least one condition must be true (OR)" },
                  ] as const
                ).map(({ c, label, hint }) => (
                  <button
                    key={c}
                    type="button"
                    title={hint}
                    aria-pressed={filter.combinator === c}
                    onClick={() => setFilter({ ...filter, combinator: c })}
                    className={cn("px-3 py-1.5 text-xs font-semibold", filter.combinator === c ? "bg-indigo-600 text-white" : "text-slate-500 hover:bg-slate-50")}
                  >
                    {label} <span className="font-normal opacity-80">({c})</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <CriteriaPanel filter={filter} onChange={setFilter} />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            aria-expanded={advOpen}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ChevronRight className={cn("h-4 w-4 text-slate-500 transition-transform", advOpen && "rotate-90")} />
              Advanced AND / OR logic
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                {filter.children.length} {filter.children.length === 1 ? "item" : "items"}
              </span>
            </span>
            <span className="hidden text-xs text-slate-500 sm:inline">Nested groups, e.g. (Dormant AND Active) OR DS01</span>
          </button>
          {advOpen && (
            <div className="border-t border-slate-100 p-4">
              <FilterGroupEditor group={filter} onChange={setFilter} />
            </div>
          )}
        </section>

        {showPreview && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">
              Preview <span className="font-normal text-slate-500">· first {PREVIEW_ROWS} matching companies</span>
            </h3>
            <ResultsTable
              rows={previewRows}
              loading={previewLoading}
              sortField={sort.field}
              sortDir={sort.dir}
              onSort={(field, dir) => {
                setRememberSort(true);
                setSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: dir ?? "asc" }));
              }}
              scope="all"
              readOnly
              columns={columns ?? undefined}
            />
          </section>
        )}
      </div>

      <aside className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:self-start xl:overflow-y-auto">
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="rounded-lg bg-linear-to-br from-indigo-950 to-indigo-700 p-4 text-white">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-200">Matching companies</p>
            {countState === "error" ? (
              <p className="mt-1 text-sm text-red-200">{countError}</p>
            ) : countState === "loading" ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-indigo-100">
                <Loader2 className="h-4 w-4 animate-spin" /> Calculating…
              </p>
            ) : (
              <p className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums">{previewCount?.toLocaleString()}</span>
                <span className="text-sm text-indigo-100">of {totalCompanies?.toLocaleString() ?? "all"} in database</span>
              </p>
            )}
            <p className="mt-1 text-xs text-indigo-200">
              {rules === 0 ? "No conditions yet — this is every company." : `${rules} condition${rules === 1 ? "" : "s"} applied`}
            </p>
          </div>

          <div>
            <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <span>Active conditions</span>
              {chips.length > 1 && (
                <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">{isAll ? "ALL must match (AND)" : "ANY can match (OR)"}</span>
              )}
            </p>
            {chips.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-400">Nothing selected yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {chips.map((c, i) => (
                  <li key={c.id}>
                    {i > 0 && <span className="mb-1 block text-center text-[10px] font-bold tracking-wider text-slate-400">{filter.combinator}</span>}
                    <span className="flex items-start justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs text-indigo-900">
                      <span className="min-w-0 break-words">{c.text}</span>
                      <button
                        type="button"
                        onClick={() => setFilter(removeTopLevel(filter, c.id))}
                        className="mt-0.5 shrink-0 rounded text-indigo-400 hover:text-red-600"
                        aria-label={`Remove condition: ${c.text}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {chips.length > 0 && (
              <button type="button" onClick={() => setFilter({ ...filter, children: [] })} className="mt-2 text-xs font-medium text-slate-500 hover:text-red-600">
                Clear all conditions
              </button>
            )}
          </div>

          <Button variant="outline" className="w-full" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showPreview ? "Hide preview" : "Preview results"}
          </Button>
          <div className="flex items-stretch gap-2">
            <Button className="min-w-0 flex-1" onClick={handleSave} disabled={saving}>
              <Save className="h-4 w-4" /> {saving ? "Saving…" : editing ? "Save changes" : "Save report"}
            </Button>
            <BuilderExportMenu
              filter={filter}
              columns={columns}
              sort={sort}
              name={name}
              disabled={countState !== "ready" || !previewCount}
              disabledReason={countState !== "ready" ? "Wait for the matching count to finish" : "No companies match these conditions"}
              canCsv={canCsv}
              canDocs={canDocs}
              onNotice={(n) => {
                setExportNotice(n);
                if (n?.kind === "ok") setTimeout(() => setExportNotice((cur) => (cur === n ? null : cur)), 4000);
              }}
            />
          </div>
          {exportNotice && (
            <p role={exportNotice.kind === "error" ? "alert" : "status"} data-testid="export-notice" className={cn("text-sm font-medium", exportNotice.kind === "error" ? "text-red-600" : "text-emerald-700")}>
              {exportNotice.text}
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {editing && <p className="text-xs text-slate-400">Saving updates this report in place — it keeps its link and history.</p>}
        </div>
      </aside>
    </div>
  );
}
