import { ChevronLeft, ChevronRight } from "lucide-react";

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex items-center justify-between px-1 py-3 text-sm text-slate-500">
      <span>
        {total === 0 ? "0 results" : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-2 text-xs font-medium text-slate-600">
          Page {page} of {pageCount}
        </span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
