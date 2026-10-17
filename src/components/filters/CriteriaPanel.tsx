"use client";

import { Building2, MapPin, Users, FileText, Bookmark, SlidersHorizontal, ArrowRight, type LucideIcon } from "lucide-react";
import { COMPANY_FILTER_FIELDS, OPERATOR_LABELS } from "@/lib/filters/fields";
import type { FilterFieldDef, FilterGroupNode, Operator } from "@/lib/filters/types";
import {
  clearFields,
  getBool,
  getChecked,
  getRange,
  getText,
  isActive,
  setBool,
  setChecked,
  setRange,
  setText,
} from "@/lib/filters/criteria";
import { cn } from "@/lib/cn";

// ONE compact filter workspace: every real field in COMPANY_FILTER_FIELDS, grouped by its registry group and laid
// out as a dense divider grid (option checkboxes in columns, from-to date/number controls on one line, flags in
// rows). It is a second editor over the SAME filter tree the AND/OR logic builder edits - no separate state.

const GROUP_ICONS: Record<string, LucideIcon> = {
  Identity: Building2,
  Address: MapPin,
  Directors: Users,
  "Filing status": FileText,
  "My CRM": Bookmark,
};

const optionRow = (on: boolean) =>
  cn(
    "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] leading-tight transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-300",
    on ? "bg-indigo-50 font-medium text-indigo-900" : "text-slate-700 hover:bg-slate-50"
  );

const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-[13px] text-slate-900 placeholder:text-slate-400 shadow-sm outline-none hover:border-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

const labelClass = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

// Single-letter options (A-Z) pack tightly; longer labels get a column wide enough not to clip or wrap awkwardly.
const compactOptions = (options: { label: string }[]) => options.length > 0 && options.every((o) => o.label.length <= 2);

type Props = { field: FilterFieldDef; root: FilterGroupNode; onChange: (n: FilterGroupNode) => void };

function EnumField({ field, root, onChange }: Props) {
  const options = field.options ?? [];
  const checked = getChecked(root, field.key);
  const toggle = (value: string) =>
    onChange(setChecked(root, field.key, checked.includes(value) ? checked.filter((v) => v !== value) : [...checked, value]));
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {field.label}
          {checked.length > 0 && <span className="ml-1.5 rounded-full bg-indigo-600 px-1.5 py-px text-[10px] text-white">{checked.length}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => onChange(setChecked(root, field.key, options.map((o) => o.value)))}
            className="rounded px-1.5 py-0.5 font-semibold text-indigo-600 hover:bg-indigo-50"
          >
            Select all
          </button>
          <span className="text-slate-300">|</span>
          <button
            type="button"
            onClick={() => onChange(setChecked(root, field.key, []))}
            disabled={checked.length === 0}
            className="rounded px-1.5 py-0.5 font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-40"
          >
            Clear all
          </button>
        </span>
      </div>
      <div
        className="grid gap-x-2 gap-y-0.5 [grid-template-columns:repeat(auto-fill,minmax(var(--opt),1fr))]"
        style={{ ["--opt" as string]: compactOptions(options) ? "4.25rem" : options.length > 8 ? "9.5rem" : "12rem" }}
      >
        {options.map((o) => (
          <label key={o.value} className={optionRow(checked.includes(o.value))}>
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
              checked={checked.includes(o.value)}
              onChange={() => toggle(o.value)}
              aria-label={`${field.label}: ${o.label}`}
            />
            <span title={o.label}>
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function BoolField({ field, root, onChange }: Props) {
  const state = getBool(root, field.key);
  return (
    <div className={cn(optionRow(state !== null), "justify-between")} title={field.description}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
          checked={state !== null}
          onChange={(e) => onChange(setBool(root, field.key, e.target.checked ? "yes" : null))}
          aria-label={field.label}
        />
        <span>{field.label}</span>
      </label>
      {state !== null && (
        <span className="inline-flex shrink-0 overflow-hidden rounded border border-indigo-300 text-[11px] font-semibold" role="group" aria-label={`${field.label} yes or no`}>
          {(["yes", "no"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => onChange(setBool(root, field.key, s))}
              className={cn("px-1.5 py-px", state === s ? "bg-indigo-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}
            >
              {s === "yes" ? "Yes" : "No"}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function RangeField({ field, root, onChange }: Props) {
  const isDate = field.type === "date";
  const r = getRange(root, field.key);
  return (
    <div className="min-w-0" title={field.description}>
      <span className={labelClass}>{field.label}</span>
      {r.custom ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-500">
          Custom condition set — edit it in the logic builder below.
        </p>
      ) : (
        <div className="@container">
          <div className={cn("flex flex-col gap-1", isDate ? "@[17rem]:flex-row @[17rem]:items-center @[17rem]:gap-1.5" : "@[11rem]:flex-row @[11rem]:items-center @[11rem]:gap-1.5")}>
          <input
            type={isDate ? "date" : "number"}
            min={isDate ? undefined : 0}
            inputMode={isDate ? undefined : "numeric"}
            aria-label={isDate ? `${field.label} from` : `${field.label} minimum`}
            placeholder={isDate ? undefined : "Min"}
            value={r.from}
            onChange={(e) => onChange(setRange(root, field.key, e.target.value, r.to))}
            className={cn(inputClass, isDate && "px-1.5")}
          />
          <ArrowRight className={cn("h-3.5 w-3.5 shrink-0 self-center rotate-90 text-slate-400", isDate ? "@[17rem]:rotate-0" : "@[11rem]:rotate-0")} aria-hidden />
          <input
            type={isDate ? "date" : "number"}
            min={isDate ? undefined : 0}
            inputMode={isDate ? undefined : "numeric"}
            aria-label={isDate ? `${field.label} to` : `${field.label} maximum`}
            placeholder={isDate ? undefined : "Max"}
            value={r.to}
            onChange={(e) => onChange(setRange(root, field.key, r.from, e.target.value))}
            className={cn(inputClass, isDate && "px-1.5")}
          />
          </div>
        </div>
      )}
    </div>
  );
}

function TextField({ field, root, onChange }: Props) {
  const t = getText(root, field.key);
  return (
    <div className="min-w-0">
      <span className={labelClass}>{field.label}</span>
      <div className="flex items-center gap-1.5">
        {field.operators.length > 1 ? (
          <select
            aria-label={`${field.label} match type`}
            value={t.operator}
            onChange={(e) => onChange(setText(root, field.key, e.target.value as Operator, t.value))}
            className={cn(inputClass, "w-[6.75rem]! flex-none px-1")}
          >
            {field.operators.map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-none text-xs text-slate-500">{OPERATOR_LABELS[field.operators[0]]}</span>
        )}
        <input
          type="text"
          aria-label={field.label}
          placeholder={field.placeholder ?? "Enter value"}
          value={t.value}
          onChange={(e) => onChange(setText(root, field.key, t.operator, e.target.value))}
          className={inputClass}
        />
      </div>
    </div>
  );
}

function GroupCell({ group, fields, filter, onChange }: { group: string; fields: FilterFieldDef[]; filter: FilterGroupNode; onChange: (n: FilterGroupNode) => void }) {
  const Icon = GROUP_ICONS[group] ?? SlidersHorizontal;
  const activeCount = fields.filter((f) => isActive(filter, f.key)).length;
  const enums = fields.filter((f) => f.type === "enum");
  const texts = fields.filter((f) => f.type === "string");
  const ranges = fields.filter((f) => f.type === "date" || f.type === "number");
  const bools = fields.filter((f) => f.type === "boolean");
  const inputsPresent = texts.length + ranges.length + bools.length > 0;
  // Inputs column + one column per checkbox-option field. Columns wrap onto the next line when the panel is narrow
  // (flex-basis = preferred width), so nothing is squeezed below a readable width.
  const optionBasis = (e: FilterFieldDef) => (compactOptions(e.options ?? []) ? "15rem" : (e.options?.length ?? 0) > 8 ? "21rem" : "14rem");

  return (
    <section
      aria-label={`${group} criteria`}
      className={cn("min-w-0 border-r border-b border-slate-200 bg-white p-4", enums.length > 0 && "col-span-full")}
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-slate-900">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white">
            <Icon className="h-3.5 w-3.5" />
          </span>
          {group}
          {activeCount > 0 && <span className="rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-semibold text-indigo-700">{activeCount} active</span>}
        </h4>
        <button
          type="button"
          onClick={() => onChange(clearFields(filter, fields.map((f) => f.key)))}
          disabled={activeCount === 0}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-40"
        >
          Clear
        </button>
      </header>
      <div className="flex flex-wrap gap-x-6 gap-y-4">
        {inputsPresent && (
          <div className="min-w-0 space-y-3" style={{ flex: `1 1 ${enums.length > 0 ? "15rem" : "0"}` }}>
            {texts.map((f) => (
              <TextField key={f.key} field={f} root={filter} onChange={onChange} />
            ))}
            {ranges.map((f) => (
              <RangeField key={f.key} field={f} root={filter} onChange={onChange} />
            ))}
            {bools.length > 0 && (
              <div className="-mx-1">
                {bools.map((f) => (
                  <BoolField key={f.key} field={f} root={filter} onChange={onChange} />
                ))}
              </div>
            )}
            {group === "Directors" && (
              <p className="text-[11px] leading-snug text-slate-400">Only companies with confirmed officer data are evaluated; never treated as zero directors.</p>
            )}
          </div>
        )}
        {enums.map((f) => (
          <div key={f.key} className="min-w-0" style={{ flex: `1 1 ${optionBasis(f)}` }}>
            <EnumField field={f} root={filter} onChange={onChange} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function CriteriaPanel({ filter, onChange }: { filter: FilterGroupNode; onChange: (next: FilterGroupNode) => void }) {
  const groups = COMPANY_FILTER_FIELDS.reduce<Record<string, FilterFieldDef[]>>((acc, f) => {
    (acc[f.group] ??= []).push(f);
    return acc;
  }, {});
  // groups with checkbox-option lists span the full row; the rest share compact columns beneath
  const entries = Object.entries(groups).sort(([, a], [, b]) => Number(b.some((f) => f.type === "enum")) - Number(a.some((f) => f.type === "enum")));

  return (
    // @container: columns follow the width of THIS panel (the page has a side column), not the viewport.
    // Cells draw their own right/bottom dividers; the -mr/-mb hides the outer edge so uneven last rows stay clean.
    <div className="@container overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="-mr-px -mb-px grid grid-cols-1 @[34rem]:grid-cols-2 @[62rem]:grid-cols-4">
        {entries.map(([group, fields]) => (
          <GroupCell key={group} group={group} fields={fields} filter={filter} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
