"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Building2, Database, FileText, ListOrdered, Lock, MapPin, Save, Scale, ShieldCheck, SlidersHorizontal, Tags, Users, Bookmark, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FIELD_CATEGORIES } from "@/lib/columns/catalogue";
import { PHASE1_COLUMNS, LOCKED_FIRST, MAX_COLUMNS } from "@/lib/columns/resolve";
import { cn } from "@/lib/cn";

interface AdminField {
  key: string;
  label: string;
  category: string;
  description: string;
  enabled: boolean;
  canSwitch: boolean;
}
interface Layout {
  id: string;
  name: string;
  columns: string[];
  isDefault: boolean;
  version: number;
}
interface AdminData {
  fields: AdminField[];
  layouts: Layout[];
}

type Msg = { tone: "ok" | "error"; text: string } | null;

// Same icon-in-a-square group headers as the Report Builder criteria cards.
const GROUP_ICONS: Record<string, LucideIcon> = {
  Identity: Building2,
  Address: MapPin,
  Classification: Tags,
  "Filing & compliance": FileText,
  Officers: Users,
  "Ownership (PSC)": ShieldCheck,
  "Charges, insolvency & other": Scale,
  "Data provenance": Database,
  "My CRM": Bookmark,
};

const PHASE1 = new Set(PHASE1_COLUMNS);
const CHOOSABLE = (k: string, byKey: Map<string, AdminField>) => byKey.get(k)?.canSwitch === true;

// The whole tool, in one panel: which of the 33 columns users may choose, which of them show by default, and in what
// order. Users' own saved columns are never touched by anything here (the server guarantees that).
export function ColumnSettingsClient() {
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  // Unsaved edits: availability switches by key, and the default column list (null = no edit in progress).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [defaultEdit, setDefaultEdit] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/columns", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Only a Super Admin can open this page." : "Could not load column settings.");
      setData((await res.json()) as AdminData);
      setPending({});
      setDefaultEdit(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time load on mount
    void load();
  }, [load]);

  const byKey = useMemo(() => new Map((data?.fields ?? []).map((f) => [f.key, f])), [data]);
  // Every column the table can already show: the 33 approved ones in their agreed order, then the other supported ones.
  const fields = useMemo(() => {
    const first = PHASE1_COLUMNS.map((k) => byKey.get(k)).filter((f): f is AdminField => !!f);
    const rest = (data?.fields ?? []).filter((f) => f.canSwitch && !PHASE1.has(f.key));
    return [...first, ...rest];
  }, [byKey, data]);
  const defaultLayout = data?.layouts.find((l) => l.isDefault) ?? null;

  const avail = useCallback(
    (key: string) => {
      if (key === LOCKED_FIRST) return true;
      const f = byKey.get(key);
      if (!f) return false;
      return key in pending ? pending[key] : f.enabled;
    },
    [byKey, pending]
  );

  const baseDefault = useMemo(
    () => (defaultLayout ? defaultLayout.columns.filter((k) => CHOOSABLE(k, byKey) && (k === LOCKED_FIRST || byKey.get(k)?.enabled)) : [LOCKED_FIRST]),
    [defaultLayout, byKey]
  );
  // What the default will be if saved now: the chosen columns that are also available, Company first.
  const defaultCols = useMemo(() => {
    const cols = (defaultEdit ?? baseDefault).filter((k) => avail(k));
    return cols[0] === LOCKED_FIRST ? cols : [LOCKED_FIRST, ...cols.filter((k) => k !== LOCKED_FIRST)];
  }, [defaultEdit, baseDefault, avail]);

  // Fields grouped by catalogue category (catalogue order), for the expandable sections.
  const groups = useMemo(() => {
    const out: { category: string; fields: AdminField[] }[] = [];
    for (const category of FIELD_CATEGORIES) {
      const inCat = fields.filter((f) => f.category === category);
      if (inCat.length) out.push({ category, fields: inCat });
    }
    return out;
  }, [fields]);

  const pendingCount = Object.keys(pending).length;
  const defaultChanged = JSON.stringify(defaultCols) !== JSON.stringify(baseDefault);
  const dirty = pendingCount > 0 || defaultChanged;

  function setAvail(keys: string[], on: boolean) {
    setPending((cur) => {
      const next = { ...cur };
      for (const key of keys) {
        const f = byKey.get(key);
        if (!f || key === LOCKED_FIRST) continue;
        if (on === f.enabled) delete next[key];
        else next[key] = on;
      }
      return next;
    });
  }

  function toggleDefault(key: string) {
    if (key === LOCKED_FIRST) return;
    setDefaultEdit(defaultCols.includes(key) ? defaultCols.filter((k) => k !== key) : defaultCols.length >= MAX_COLUMNS ? defaultCols : [...defaultCols, key]);
  }
  function move(key: string, dir: -1 | 1) {
    const cols = [...defaultCols];
    const i = cols.indexOf(key);
    const j = i + dir;
    if (i < 1 || j < 1 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    setDefaultEdit(cols);
  }

  function discard() {
    setPending({});
    setDefaultEdit(null);
    setMsg(null);
  }

  // One save: availability first (so the default can only contain available columns), then the default columns.
  async function save() {
    if (!defaultLayout) return;
    setBusy(true);
    setMsg(null);
    try {
      if (pendingCount > 0) {
        const updates = Object.entries(pending).map(([key, enabled]) => ({ key, enabled }));
        const res = await fetch("/api/admin/columns/fields", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMsg({ tone: "error", text: out.error ?? "Could not save which columns users can choose." });
          return;
        }
      }
      if (defaultChanged) {
        const res = await fetch(`/api/admin/columns/layouts/${defaultLayout.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ columns: defaultCols }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMsg({ tone: "error", text: out.error ?? "Could not save the default columns." });
          await load();
          return;
        }
      }
      await load();
      setMsg({ tone: "ok", text: "Defaults saved. Users' own saved columns were not changed." });
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!data) return <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading column settings…</div>;

  // One list: default columns first (in their order, with arrows), then the rest. Same 33 rows, no repeated grids.
  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{fields.filter((f) => avail(f.key)).length}</span> of {fields.length} columns available to users ·{" "}
          <span className="font-semibold text-slate-900">{defaultCols.length}</span> shown by default
        </p>
        {msg && (
          <span role="status" className={cn("rounded-md border px-2.5 py-1 text-xs", msg.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700")}>
            {msg.text}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Unsaved changes</span>}
          <Button size="sm" variant="outline" disabled={!dirty || busy} onClick={discard}>
            Discard
          </Button>
          <Button size="sm" disabled={!dirty || busy || !defaultLayout} onClick={() => void save()}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </div>

      <section aria-label="Default column order" className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <header className="mb-2.5 flex flex-wrap items-center gap-2">
          <h4 className="flex items-center gap-2 text-[13px] font-semibold text-slate-900">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-white">
              <ListOrdered className="h-3.5 w-3.5" />
            </span>
            Default order
          </h4>
          <span className="text-xs text-slate-500">Left to right, as users without their own columns see them. Use the arrows to move a column.</span>
        </header>
        <ol className="flex flex-wrap gap-1.5">
          {defaultCols.map((key, i) => {
            const f = byKey.get(key);
            const locked = key === LOCKED_FIRST;
            const name = f?.label ?? key;
            return (
              <li key={key} className={cn("inline-flex items-center gap-1 rounded-lg border py-1 pl-2 text-[13px]", locked ? "border-slate-300 bg-slate-100 pr-2" : "border-indigo-200 bg-indigo-50/60 pr-0.5")}>
                <span className="text-[11px] font-semibold tabular-nums text-slate-400">{i + 1}</span>
                <span className="font-medium text-slate-800">{name}</span>
                {locked ? (
                  <Lock className="h-3 w-3 text-slate-500" aria-label="Always on, always first" />
                ) : (
                  <span className="flex items-center">
                    <button type="button" onClick={() => move(key, -1)} disabled={i <= 1} aria-label={`Move ${name} earlier`} className="rounded p-0.5 text-slate-500 hover:bg-white disabled:opacity-30">
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => move(key, 1)} disabled={i === defaultCols.length - 1} aria-label={`Move ${name} later`} className="rounded p-0.5 text-slate-500 hover:bg-white disabled:opacity-30">
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 shadow-sm md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
          const Icon = GROUP_ICONS[g.category] ?? SlidersHorizontal;
          const availCount = g.fields.filter((f) => avail(f.key)).length;
          const defCount = g.fields.filter((f) => defaultCols.includes(f.key)).length;
          return (
            <section key={g.category} aria-label={g.category} className="min-w-0 bg-white p-3.5">
              <header className="mb-2 flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-2 text-[13px] font-semibold text-slate-900">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-white">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  {g.category}
                </h4>
                <span className="text-[11px] text-slate-400">
                  {availCount}/{g.fields.length} available · {defCount} default
                </span>
              </header>
              <div className="mb-1 grid grid-cols-[1fr_3.75rem_3.75rem] gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <span />
                <span className="text-center">Available</span>
                <span className="text-center">Default</span>
              </div>
              <div className="divide-y divide-slate-100">
                {g.fields.map((f) => {
                  const locked = f.key === LOCKED_FIRST;
                  const available = avail(f.key);
                  const isDefault = defaultCols.includes(f.key);
                  return (
                    <div key={f.key} className="grid grid-cols-[1fr_3.75rem_3.75rem] items-start gap-1 py-1.5">
                      <div className="min-w-0">
                        <p className={cn("text-sm font-medium leading-snug", available ? "text-slate-900" : "text-slate-400")}>
                          {f.label}
                          {locked && <Lock className="ml-1.5 inline h-3 w-3 text-slate-400" aria-label="Always on, always first" />}
                        </p>
                        <p className="text-[11px] leading-snug text-slate-400">{f.description}</p>
                      </div>
                      <label className="flex justify-center pt-0.5">
                        <input type="checkbox" className="h-4 w-4 cursor-pointer accent-indigo-600" aria-label={`${f.label} available to users`} checked={available} disabled={locked} onChange={() => setAvail([f.key], !available)} />
                      </label>
                      <label className="flex justify-center pt-0.5">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-indigo-600"
                          aria-label={`${f.label} shown by default`}
                          checked={isDefault}
                          disabled={locked || !available || (!isDefault && defaultCols.length >= MAX_COLUMNS)}
                          onChange={() => toggleDefault(f.key)}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
