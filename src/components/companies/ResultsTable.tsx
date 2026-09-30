"use client";

import Link from "next/link";
import { ArrowUp, ArrowDown, Star, Trash2, RotateCcw, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDateOnly, STATUS_LABELS, STATUS_TONE } from "@/lib/data/format";
import type { SortableField } from "@/lib/data/companies";
import { cn } from "@/lib/cn";

export interface CompanyRow {
  id: string;
  companyNumber: string;
  name: string;
  status: keyof typeof STATUS_LABELS;
  incorporationDate: string;
  registeredPostcode: string;
  directorCount: number;
  singleDirector: boolean;
  accountsOverdue: boolean;
  hasDS01: boolean;
  followed: boolean;
  trashed: boolean;
}

const COLUMNS: { key: SortableField; label: string }[] = [
  { key: "name", label: "Company" },
  { key: "companyNumber", label: "Number" },
  { key: "status", label: "Status" },
  { key: "incorporationDate", label: "Incorporated" },
  { key: "registeredPostcode", label: "Postcode" },
];

export function ResultsTable({
  rows,
  loading,
  sortField,
  sortDir,
  onSort,
  onToggleFollow,
  onToggleTrash,
  scope,
}: {
  rows: CompanyRow[];
  loading: boolean;
  sortField: SortableField;
  sortDir: "asc" | "desc";
  onSort: (field: SortableField) => void;
  onToggleFollow: (id: string, next: boolean) => void;
  onToggleTrash: (id: string, next: boolean) => void;
  scope: "all" | "followed" | "trashed";
}) {
  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No companies match your filters"
        description="Try widening your filters, or clear them to see all companies."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="border-b border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key} className="px-4 py-3 font-medium">
                <button
                  onClick={() => onSort(col.key)}
                  className="inline-flex items-center gap-1 hover:text-slate-700"
                >
                  {col.label}
                  {sortField === col.key &&
                    (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </button>
              </th>
            ))}
            <th className="px-4 py-3 font-medium">Directors</th>
            <th className="px-4 py-3 font-medium">Filing</th>
            <th className="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className={cn("divide-y divide-slate-100", loading && "opacity-50")}>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-slate-50/60">
              <td className="px-4 py-3">
                <Link href={`/companies/${row.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                  {row.name}
                </Link>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-slate-500">{row.companyNumber}</td>
              <td className="px-4 py-3">
                <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
              </td>
              <td className="px-4 py-3 text-slate-600">{formatDateOnly(row.incorporationDate)}</td>
              <td className="px-4 py-3 text-slate-600">{row.registeredPostcode}</td>
              <td className="px-4 py-3 text-slate-600">
                {row.directorCount}
                {row.singleDirector && (
                  <Badge tone="amber" className="ml-1.5">
                    Single
                  </Badge>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {row.accountsOverdue && <Badge tone="red">Late accounts</Badge>}
                  {row.hasDS01 && <Badge tone="amber">DS01</Badge>}
                  {!row.accountsOverdue && !row.hasDS01 && <span className="text-slate-400">—</span>}
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => onToggleFollow(row.id, !row.followed)}
                    className={cn(
                      "rounded-md p-1.5 hover:bg-amber-50",
                      row.followed ? "text-amber-500" : "text-slate-300 hover:text-amber-500"
                    )}
                    title={row.followed ? "Unfollow" : "Follow"}
                  >
                    <Star className={cn("h-4 w-4", row.followed && "fill-amber-400")} />
                  </button>
                  {scope === "trashed" ? (
                    <button
                      onClick={() => onToggleTrash(row.id, false)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"
                      title="Restore"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => onToggleTrash(row.id, true)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      title="Send to trash"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
