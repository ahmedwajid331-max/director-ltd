"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Trash2 } from "lucide-react";

export function ReportRowActions({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      await fetch(`/api/reports/${reportId}/refresh`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this saved report? This does not delete any companies.")) return;
    setBusy(true);
    try {
      await fetch(`/api/reports/${reportId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <button onClick={refresh} disabled={busy} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
        <RefreshCw className="h-4 w-4" />
      </button>
      <button onClick={remove} disabled={busy} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
