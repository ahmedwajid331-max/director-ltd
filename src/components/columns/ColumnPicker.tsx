"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Lock, RotateCcw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { type Availability } from "@/lib/columns/catalogue";
import { CheckboxGroups } from "./CheckboxGroups";
import { LOCKED_FIRST, MAX_COLUMNS } from "@/lib/columns/resolve";
import { cn } from "@/lib/cn";

interface PickerField {
  key: string;
  label: string;
  category: string;
  description: string;
  availability: Availability;
  sortable: boolean;
  filterable: boolean;
}
interface PickerLayout {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  columns: string[];
}
interface PickerConfig {
  fields: PickerField[];
  layouts: PickerLayout[];
  defaultLayoutId: string;
  columns: string[];
  hasSaved: boolean;
  recommendedChanged: boolean;
}

// Choose, order, save and reset the signed-in user's own table columns. Used in the Companies table and on Settings.
// Only fields the administrator has switched on are offered. Nothing here can change what other people see.
export function ColumnPicker({
  variant,
  onApply,
  onClose,
}: {
  variant: "panel" | "card";
  // Called with the columns the table should now draw (also after save / reset).
  onApply?: (columns: string[]) => void;
  onClose?: () => void;
}) {
  const [config, setConfig] = useState<PickerConfig | null>(null);
  const [selected, setSelected] = useState<string[]>([LOCKED_FIRST]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseLayoutId, setBaseLayoutId] = useState<string>("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/columns/config", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load column options.");
      const data = (await res.json()) as PickerConfig;
      setConfig(data);
      setSelected(data.columns);
      setBaseLayoutId(data.defaultLayoutId);
      return data;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time load of this user's column options on mount
    void load();
  }, [load]);

  const byKey = useMemo(() => new Map((config?.fields ?? []).map((f) => [f.key, f])), [config]);
  const q = search.trim().toLowerCase();
  const shownFields = useMemo(() => (config?.fields ?? []).filter((f) => !q || f.label.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)), [config, q]);

  function toggle(key: string) {
    if (key === LOCKED_FIRST) return;
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : cur.length >= MAX_COLUMNS ? cur : [...cur, key]));
  }
  function toggleGroup(keys: string[], on: boolean) {
    setSelected((cur) => {
      let next = [...cur];
      for (const k of keys) {
        if (k === LOCKED_FIRST) continue;
        if (on && !next.includes(k) && next.length < MAX_COLUMNS) next.push(k);
        if (!on) next = next.filter((x) => x !== k);
      }
      return next;
    });
  }
  function move(key: string, dir: -1 | 1) {
    setSelected((cur) => {
      const i = cur.indexOf(key);
      const j = i + dir;
      if (i < 1 || j < 1 || j >= cur.length) return cur; // Company stays first
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function apply() {
    onApply?.(selected);
    setMessage({ tone: "ok", text: "Applied to this view. Use “Save as my default” to keep it." });
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/columns/preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columns: selected, baseLayoutId: config?.defaultLayoutId ?? null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error ?? "Could not save your columns." });
        return;
      }
      onApply?.(data.columns ?? selected);
      await load();
      setMessage({ tone: "ok", text: "Saved. These are now your default columns." });
    } finally {
      setBusy(false);
    }
  }

  async function resetToRecommended(textOk = "Reset. You are using the recommended layout again.") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/columns/preference", { method: "DELETE" });
      if (!res.ok) {
        setMessage({ tone: "error", text: "Could not reset your columns." });
        return;
      }
      const data = await load();
      if (data) onApply?.(data.columns);
      setMessage({ tone: "ok", text: textOk });
    } finally {
      setBusy(false);
    }
  }

  async function keepMine() {
    setBusy(true);
    try {
      await fetch("/api/columns/preference", { method: "PATCH" });
      await load();
      setMessage({ tone: "ok", text: "Kept. Your saved columns are unchanged." });
    } finally {
      setBusy(false);
    }
  }

  function startFrom(id: string) {
    const layout = config?.layouts.find((l) => l.id === id);
    if (layout) {
      setSelected(layout.columns);
      setMessage({ tone: "ok", text: `Loaded “${layout.name}”. Adjust it, then apply or save.` });
    }
  }

  const wrap = variant === "card" ? "rounded-2xl border border-slate-200 bg-white shadow-sm" : "rounded-xl border border-violet-200 bg-white shadow-md";

  if (loadError) {
    return (
      <div className={cn(wrap, "p-4 text-sm text-red-700")} role="alert">
        {loadError}{" "}
        <button type="button" onClick={() => void load()} className="font-semibold underline">
          Try again
        </button>
      </div>
    );
  }
  if (!config) return <div className={cn(wrap, "p-4 text-sm text-slate-500")}>Loading column options…</div>;

  return (
    <section className={wrap} aria-label="Choose table columns">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-violet-50/70 to-white px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Your table columns</h3>
          <p className="text-xs text-slate-500">
            {config.hasSaved ? "You are using your own saved columns." : "You are using the recommended layout."} {selected.length} column{selected.length === 1 ? "" : "s"} chosen.
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close column chooser" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {config.recommendedChanged && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900" role="status">
          <span>The recommended layout was updated. Your saved columns have not changed.</span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void resetToRecommended("Now using the recommended layout.")}>
              Use the new recommendation
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void keepMine()}>
              Keep my columns
            </Button>
          </span>
        </div>
      )}

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`col-layout-${variant}`} className="text-xs font-medium text-slate-600">
            Start from
          </label>
          <select
            id={`col-layout-${variant}`}
            value={baseLayoutId}
            onChange={(e) => {
              setBaseLayoutId(e.target.value);
              startFrom(e.target.value);
            }}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {config.layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.isDefault ? " (recommended)" : ""}
              </option>
            ))}
          </select>
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search columns" aria-label="Search columns" className="pl-9" />
          </div>
        </div>

        {shownFields.length === 0 ? (
          <p className="text-sm text-slate-500">No columns match “{search}”.</p>
        ) : (
          <CheckboxGroups
            idPrefix={`pick-${variant}`}
            fields={shownFields}
            isChecked={(k) => selected.includes(k)}
            isLocked={(k) => k === LOCKED_FIRST}
            isDisabled={(k) => !selected.includes(k) && selected.length >= MAX_COLUMNS}
            onToggle={toggle}
            onToggleGroup={(_c, keys, on) => toggleGroup(keys, on)}
          />
        )}

        <details className="rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700">Order of your columns, left to right ({selected.length})</summary>
          <ol className="max-h-[320px] space-y-1 overflow-y-auto border-t border-slate-100 p-2">
            {selected.map((key, i) => {
              const f = byKey.get(key);
              const locked = key === LOCKED_FIRST;
              return (
                <li key={key} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1 text-sm">
                  <span className="w-5 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-800">{f?.label ?? key}</span>
                  {locked ? (
                    <Badge tone="slate">
                      <Lock className="h-3 w-3" /> Always first
                    </Badge>
                  ) : (
                    <span className="flex items-center gap-0.5">
                      <button type="button" onClick={() => move(key, -1)} disabled={i <= 1} aria-label={`Move ${f?.label ?? key} left`} className="rounded p-1 text-slate-500 hover:bg-white disabled:opacity-30">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => move(key, 1)} disabled={i === selected.length - 1} aria-label={`Move ${f?.label ?? key} right`} className="rounded p-1 text-slate-500 hover:bg-white disabled:opacity-30">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => toggle(key)} aria-label={`Remove ${f?.label ?? key}`} className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
        {onApply && (
          <Button size="sm" variant="outline" disabled={busy} onClick={apply}>
            <Check className="h-4 w-4" /> Apply to this view
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          Save as my default
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resetToRecommended()}>
          <RotateCcw className="h-4 w-4" /> Reset to recommended
        </Button>
        {message && (
          <span role="status" className={cn("text-sm", message.tone === "ok" ? "text-emerald-700" : "text-red-600")}>
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
