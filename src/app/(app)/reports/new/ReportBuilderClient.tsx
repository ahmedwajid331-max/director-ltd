"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { FilterGroupEditor } from "@/components/filters/FilterGroup";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { emptyFilterGroup, type FilterGroupNode } from "@/lib/filters/types";

export function ReportBuilderClient() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterGroupNode>(emptyFilterGroup());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dailyRefresh, setDailyRefresh] = useState(true);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const pending = sessionStorage.getItem("pendingReportFilter");
    if (pending) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from sessionStorage on mount
        setFilter(JSON.parse(pending));
      } catch {
        /* ignore malformed sessionStorage payload */
      }
      sessionStorage.removeItem("pendingReportFilter");
      sessionStorage.removeItem("pendingReportQuery");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await fetch("/api/companies/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, page: 1, pageSize: 1 }),
      });
      const data = await res.json();
      setPreviewCount(data.total ?? 0);
    }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  async function handleSave() {
    if (!name.trim()) {
      setError("Give the report a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), filter, dailyRefresh }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save the report.");
        return;
      }
      router.push(`/reports/${data.report.id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2">
        <div>
          <Label>Report name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dormant companies with DS01 filed" />
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short note for your team" />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2">
          <input type="checkbox" checked={dailyRefresh} onChange={(e) => setDailyRefresh(e.target.checked)} />
          Refresh this report&apos;s results automatically every day
        </label>
      </div>

      <FilterGroupEditor group={filter} onChange={setFilter} />

      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div className="text-sm text-slate-600">
          {previewCount === null ? "Calculating matches…" : (
            <>
              <span className="font-semibold text-slate-900">{previewCount.toLocaleString()}</span> companies match
              this filter right now
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="text-sm text-red-600">{error}</span>}
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4" /> Save report
          </Button>
        </div>
      </div>
    </div>
  );
}
