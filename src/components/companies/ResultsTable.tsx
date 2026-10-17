"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown, ChevronLeft, ChevronRight, Star, Trash2, RotateCcw, Building2, Bookmark, Flag, CalendarPlus, Share2, Check } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDateOnly, STATUS_LABELS } from "@/lib/data/format";
import type { SortableField } from "@/lib/data/companies";
import type { OfficerFreshness } from "@/lib/data/director-display";
import { BUILTIN_DEFAULT } from "@/lib/columns/resolve";
import { rendererFor } from "./columnDefs";
import { cn } from "@/lib/cn";

export interface CompanyRow {
  id: string;
  companyNumber: string;
  name: string;
  status: keyof typeof STATUS_LABELS;
  incorporationDate: string;
  registeredPostcode: string;
  directorCount: number;
  officersCoverage?: string;
  officersFetchedAt?: string | null;
  officersDirtyAt?: string | null;
  officerFreshness?: OfficerFreshness;
  singleDirector: boolean;
  accountsOverdue: boolean;
  hasDS01: boolean;
  followed: boolean;
  trashed: boolean;
  saved?: boolean;
  redFlagged?: boolean;
  // Present on every search/report row (the API returns the full company record); used for Type / Location / the expanded record.
  type?: string;
  registeredAddress1?: string;
  registeredAddress2?: string | null;
  registeredCity?: string;
  registeredCounty?: string | null;
  sicCodes?: string;
  dormant?: boolean;
  accountsNextDue?: string | null;
  confirmationNextDue?: string | null;
  ds01FiledAt?: string | null;
  // Further stored fields the API already returns, shown only when a user chooses those columns.
  statusDetail?: string | null;
  accountsLastMadeUp?: string | null;
  confirmationLastMadeUp?: string | null;
  confirmationOverdue?: boolean;
  accountType?: string | null;
  source?: string;
  chLastFetchedAt?: string | null;
  dissolutionDate?: string | null;
  officersUnavailableReason?: string | null;
}

// Plain-words direction shown on the active header (arrow alone is easy to miss).
const AGE_SORT_TEXT = { asc: "Youngest first", desc: "Oldest first" };
const SORT_TEXT: Partial<Record<SortableField, { asc: string; desc: string }>> = {
  name: { asc: "A–Z", desc: "Z–A" },
  companyNumber: { asc: "ASC", desc: "DESC" },
};

function SortIndicator({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 text-slate-300 group-hover:text-slate-500" aria-hidden />;
  return dir === "asc" ? (
    <ArrowUp className="h-3 w-3 text-indigo-600" aria-hidden />
  ) : (
    <ArrowDown className="h-3 w-3 text-indigo-600" aria-hidden />
  );
}

const EMPTY_ICON = { all: Building2, followed: Star, saved: Bookmark, redFlagged: Flag, trashed: Trash2 } as const;
const EMPTY_COPY: Record<"all" | "followed" | "saved" | "redFlagged" | "trashed", [string, string]> = {
  all: ["No companies match your filters", "Try widening your filters, or clear them to see all companies."],
  followed: ["No followed companies to show", "Follow a company from UK Companies to watch it here, or clear your filters."],
  saved: ["No saved companies to show", "Save companies from UK Companies to build your working list, or clear your filters."],
  redFlagged: ["No red-flagged companies to show", "Red flags are your own private markers. Flag a company to see it here, or clear your filters."],
  trashed: ["Trash is empty", "Companies you move to Trash appear here and can be restored at any time, or clear your filters."],
};

export function ResultsTable({
  rows,
  loading,
  sortField,
  sortDir,
  onSort,
  onToggleFollow,
  onToggleTrash,
  onToggleSaved,
  onToggleRedFlag,
  scope,
  selectedIds,
  onToggleSelect,
  onTogglePageSelection,
  startIndex = 0,
  readOnly = false,
  columns,
}: {
  rows: CompanyRow[];
  loading: boolean;
  sortField: SortableField;
  sortDir: "asc" | "desc";
  onSort: (field: SortableField, dir?: "asc" | "desc") => void;
  onToggleFollow?: (id: string, next: boolean) => void;
  onToggleTrash?: (id: string, next: boolean) => void;
  onToggleSaved?: (id: string, next: boolean) => void;
  onToggleRedFlag?: (id: string, next: boolean) => void;
  scope: "all" | "followed" | "saved" | "redFlagged" | "trashed";
  // Optional row selection (omit to render the table without checkboxes).
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onTogglePageSelection?: () => void;
  // Number of rows before this page, so the "#" column continues across pages.
  // Presentation only - nothing is stored.
  startIndex?: number;
  // Hides the Actions column (used for report previews).
  readOnly?: boolean;
  // Ordered catalogue keys to draw after the pinned checkbox and number columns. Defaults to the standard nine.
  columns?: string[];
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Wide column sets scroll sideways inside this box (never the page). The buttons below are shown only while it overflows.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setOverflowing(el.scrollWidth > el.clientWidth + 1));
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [rows.length, columns]);
  const scrollColumns = (dir: -1 | 1) => scrollRef.current?.scrollBy({ left: dir * Math.max(240, Math.round((scrollRef.current?.clientWidth ?? 600) * 0.8)), behavior: "smooth" });
  const selectable = !readOnly && !!selectedIds && !!onToggleSelect && !!onTogglePageSelection;
  const selectedOnPage = selectedIds ? rows.filter((r) => selectedIds.has(r.id)).length : 0;

  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        icon={EMPTY_ICON[scope ?? "all"]}
        title={EMPTY_COPY[scope ?? "all"][0]}
        description={EMPTY_COPY[scope ?? "all"][1]}
      />
    );
  }

  // The Company column is always first (pinned). Unknown or non-displayable keys are skipped, so a stale list can never
  // break the table.
  const requested = columns && columns.length ? columns : BUILTIN_DEFAULT;
  const cols = [{ key: "name", renderer: null }, ...requested.filter((k) => k !== "name").map((k) => ({ key: k, renderer: rendererFor(k) })).filter((c) => c.renderer)];

  const iconBtn = "rounded-md p-1.5 transition-colors";

  // Sticky left block: [checkbox] [#] [COMPANY]. Fixed widths so each column's `left` offset is exact and header and
  // body cells line up; solid backgrounds so scrolled content never shows through; a soft divider after COMPANY.
  const CB_W = selectable ? 40 : 0;
  const NUM_W = 64;
  const nameLeft = CB_W + NUM_W;
  const stickyBg = (id: string) => (selectedIds?.has(id) ? "bg-indigo-50" : "bg-white group-even/row:bg-slate-50 group-hover/row:bg-indigo-50");
  const stickyShadow = "border-r border-slate-200 shadow-[3px_0_4px_-2px_rgba(15,23,42,0.10)]";

  return (
    <div>
      {overflowing && (
        <div className="mb-1.5 flex items-center justify-end gap-1 text-xs text-slate-500">
          <span>More columns to the right: scroll sideways</span>
          <button type="button" onClick={() => scrollColumns(-1)} aria-label="Scroll columns left" className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-50 focus-ring">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => scrollColumns(1)} aria-label="Scroll columns right" className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-50 focus-ring">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    <div ref={scrollRef} tabIndex={0} role="region" aria-label="Companies table (scrolls sideways)" className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm focus-ring">
      <table className="w-full min-w-[1280px] text-left text-[13px]">
        <thead className="border-b border-slate-200 bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
          <tr>
            {selectable && (
              <th className="sticky left-0 z-[3] w-10 min-w-10 max-w-10 bg-slate-100 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all companies on this page"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={rows.length > 0 && selectedOnPage === rows.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedOnPage > 0 && selectedOnPage < rows.length;
                  }}
                  onChange={onTogglePageSelection}
                />
              </th>
            )}
            <th className="sticky z-[3] w-16 min-w-16 max-w-16 bg-slate-100 px-3 py-2.5 text-right font-semibold text-slate-500" style={{ left: CB_W }} scope="col" title="Result number (not stored)">
              #
            </th>
            {cols.map((col) => {
              const isName = col.key === "name";
              const sortKey: SortableField | undefined = isName ? "name" : col.renderer?.sortKey;
              const label = isName ? "Company" : col.renderer!.header;
              const hint = isName ? "Sort by company name, A → Z / Z → A" : col.renderer!.hint;
              const active = !!sortKey && sortField === sortKey;
              // Age mirrors Incorporated: the same server sort read the other way round.
              const inverted = !isName && !!col.renderer?.sortInverted;
              const shownDir: "asc" | "desc" = inverted ? (sortDir === "asc" ? "desc" : "asc") : sortDir;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={sortKey ? (active ? (shownDir === "asc" ? "ascending" : "descending") : "none") : undefined}
                  className={cn("p-0 font-semibold", active && !isName && "bg-indigo-50/70", isName && cn("sticky z-[3]", stickyShadow, active ? "bg-indigo-50" : "bg-slate-100"))}
                  style={isName ? { left: nameLeft } : undefined}
                >
                  {sortKey ? (
                    <button
                      onClick={() => (inverted && !active ? onSort(sortKey, "desc") : onSort(sortKey))}
                      title={hint}
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-1 whitespace-nowrap px-3 py-2.5 uppercase tracking-wide transition-colors hover:bg-slate-200/60 hover:text-slate-900",
                        active && "text-indigo-700"
                      )}
                    >
                      {label}
                      <SortIndicator active={active} dir={shownDir} />
                      {active && (inverted ? AGE_SORT_TEXT : SORT_TEXT[sortKey]) && (
                        <span className="rounded bg-indigo-100 px-1 text-[10px] font-bold normal-case tracking-normal text-indigo-700">
                          {(inverted ? AGE_SORT_TEXT : SORT_TEXT[sortKey]!)[shownDir]}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span title={`${hint} (Not sortable: this column has no single value to order by.)`} className="flex w-full items-center gap-1 whitespace-nowrap px-3 py-2.5 uppercase tracking-wide text-slate-600">
                      {label}
                    </span>
                  )}
                </th>
              );
            })}
            {!readOnly && (
              <th className="px-3 py-2.5 text-right font-semibold" scope="col">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody className={cn("divide-y divide-slate-100", loading && "opacity-50")}>
          {rows.map((row, i) => [
            <tr
              key={row.id}
              title="Click to open company record"
              onClick={(e) => {
                // Whole-row click opens the company, but never hijacks links, buttons or checkboxes.
                if ((e.target as HTMLElement).closest("a,button,input,label")) return;
                router.push(`/companies/${row.id}`);
              }}
              className={cn(
                "group/row cursor-pointer odd:bg-white even:bg-slate-50/40 hover:bg-indigo-50/50",
                selectedIds?.has(row.id) && "!bg-indigo-50"
              )}
            >
              {selectable && (
                <td className={cn("sticky left-0 z-[1] w-10 min-w-10 max-w-10 px-3 py-2", stickyBg(row.id))}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    className="h-4 w-4 rounded border-slate-300"
                    checked={selectedIds.has(row.id)}
                    onChange={() => onToggleSelect(row.id)}
                  />
                </td>
              )}
              <td className={cn("sticky z-[1] w-16 min-w-16 max-w-16 px-2 py-2 text-right text-xs tabular-nums text-slate-400", stickyBg(row.id))} style={{ left: CB_W }}>
                <button
                  type="button"
                  onClick={() => setExpanded((e) => (e === row.id ? null : row.id))}
                  aria-expanded={expanded === row.id}
                  aria-label={expanded === row.id ? "Collapse record" : "Expand record"}
                  title="Show a quick record preview"
                  className="mr-1 inline-flex align-middle text-slate-300 hover:text-indigo-600"
                >
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded === row.id && "rotate-90 text-indigo-600")} />
                </button>
                {(startIndex + i + 1).toLocaleString()}
              </td>
              <td className={cn("sticky z-[1] px-3 py-2", stickyShadow, stickyBg(row.id))} style={{ left: nameLeft }}>
                <div className="flex max-w-[300px] items-center gap-1.5">
                  <Link
                    href={`/companies/${row.id}`}
                    title={row.name}
                    className="truncate font-semibold text-indigo-700 underline-offset-2 hover:text-indigo-900 hover:underline"
                  >
                    {row.name}
                  </Link>
                  {row.saved && <Bookmark className="h-3.5 w-3.5 shrink-0 fill-indigo-500 text-indigo-500" aria-label="Saved" />}
                  {row.redFlagged && <Flag className="h-3.5 w-3.5 shrink-0 fill-red-500 text-red-500" aria-label="Red flag" />}
                </div>
              </td>
              {cols.slice(1).map((col) => (
                <td key={col.key} className={col.renderer!.tdClass}>
                  {col.renderer!.render(row)}
                </td>
              ))}
              {!readOnly && (
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-0.5">
                    {onToggleFollow && (
                      <button
                        onClick={() => onToggleFollow(row.id, !row.followed)}
                        className={cn(iconBtn, "hover:bg-amber-50", row.followed ? "text-amber-500" : "text-slate-300 hover:text-amber-500")}
                        title={row.followed ? "Unfollow" : "Follow"}
                        aria-label={row.followed ? "Unfollow" : "Follow"}
                      >
                        <Star className={cn("h-4 w-4", row.followed && "fill-amber-400")} />
                      </button>
                    )}
                    {onToggleSaved && (
                      <button
                        onClick={() => onToggleSaved(row.id, !row.saved)}
                        className={cn(iconBtn, "hover:bg-indigo-50", row.saved ? "text-indigo-500" : "text-slate-300 hover:text-indigo-500")}
                        title={row.saved ? "Remove from Saved" : "Save: keep this company for later"}
                        aria-label={row.saved ? "Remove from Saved" : "Save company"}
                      >
                        <Bookmark className={cn("h-4 w-4", row.saved && "fill-indigo-500")} />
                      </button>
                    )}
                    {onToggleRedFlag && (
                      <button
                        onClick={() => onToggleRedFlag(row.id, !row.redFlagged)}
                        className={cn(iconBtn, "hover:bg-red-50", row.redFlagged ? "text-red-500" : "text-slate-300 hover:text-red-500")}
                        title={row.redFlagged ? "Remove red flag" : "Red flag: mark as important / needs attention"}
                        aria-label={row.redFlagged ? "Remove red flag" : "Red flag"}
                      >
                        <Flag className={cn("h-4 w-4", row.redFlagged && "fill-red-500")} />
                      </button>
                    )}
                    <Link
                      href={`/companies/${row.id}?tab=followups`}
                      className={cn(iconBtn, "text-slate-300 hover:bg-indigo-50 hover:text-indigo-600")}
                      title="Schedule a follow-up (appears in your Calendar)"
                      aria-label={`Schedule a follow-up for ${row.name}`}
                    >
                      <CalendarPlus className="h-4 w-4" />
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(`${window.location.origin}/companies/${row.id}`)
                          .then(() => {
                            setCopiedId(row.id);
                            setTimeout(() => setCopiedId((c) => (c === row.id ? null : c)), 2000);
                          })
                          .catch(() => {});
                      }}
                      className={cn(iconBtn, copiedId === row.id ? "text-emerald-600" : "text-slate-300 hover:bg-indigo-50 hover:text-indigo-600")}
                      title={copiedId === row.id ? "Link copied" : "Copy a link to this company (opens for signed-in users only; your notes stay private)"}
                      aria-label={copiedId === row.id ? "Link copied" : `Copy link to ${row.name}`}
                    >
                      {copiedId === row.id ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
                    </button>
                    {onToggleTrash &&
                      (scope === "trashed" ? (
                        <button
                          onClick={() => onToggleTrash(row.id, false)}
                          className={cn(iconBtn, "text-slate-400 hover:bg-emerald-50 hover:text-emerald-600")}
                          title="Restore"
                          aria-label="Restore"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => onToggleTrash(row.id, true)}
                          className={cn(iconBtn, "text-slate-400 hover:bg-red-50 hover:text-red-600")}
                          title="Send to trash"
                          aria-label="Send to trash"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ))}
                  </div>
                </td>
              )}
            </tr>,
            expanded === row.id && (
              <tr key={`${row.id}-record`} className="bg-slate-50">
                <td colSpan={cols.length + 1 + (selectable ? 1 : 0) + (readOnly ? 0 : 1)} className="px-4 py-3">
                  <dl className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ["Registered address", [row.registeredAddress1, row.registeredAddress2, row.registeredCity, row.registeredCounty, row.registeredPostcode].filter(Boolean).join(", ") || "—"],
                      ["SIC code(s)", row.sicCodes ? row.sicCodes.split(/[;,|]/).map((x) => x.trim()).filter(Boolean).join(", ") : "Not provided"],
                      ["Accounts next due", row.accountsNextDue ? formatDateOnly(row.accountsNextDue) : "—"],
                      ["Confirmation statement due", row.confirmationNextDue ? formatDateOnly(row.confirmationNextDue) : "—"],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
                        <dd className="mt-0.5 text-slate-800">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <Link href={`/companies/${row.id}`} className="mt-2 inline-block text-xs font-semibold text-indigo-700 hover:underline">
                    Open full company record →
                  </Link>
                </td>
              </tr>
            ),
          ])}
        </tbody>
      </table>
    </div>
    </div>
  );
}
