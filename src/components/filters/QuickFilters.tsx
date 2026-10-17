"use client";

import type { FilterGroupNode, FilterRule } from "@/lib/filters/types";
import { COMPANY_STATUS_OPTIONS, COMPANY_TYPE_OPTIONS } from "@/lib/filters/fields";

// Always-visible filter bar (the company-data-platform pattern): a row of simple controls under the search box.
// Each control owns exactly one top-level rule in the SAME filter tree the advanced AND/OR builder edits, so chips,
// saved reports, exports and the server-side query all keep working unchanged. No new fields are introduced.

type Preset = { value: string; label: string; rule: Pick<FilterRule, "field" | "operator" | "value" | "value2"> };

const AGE: Preset[] = [
  { value: "lt1", label: "Under 1 year", rule: { field: "companyAgeYears", operator: "lt", value: 1 } },
  { value: "1-3", label: "1 – 3 years", rule: { field: "companyAgeYears", operator: "between", value: 1, value2: 3 } },
  { value: "3-10", label: "3 – 10 years", rule: { field: "companyAgeYears", operator: "between", value: 3, value2: 10 } },
  { value: "10+", label: "10+ years", rule: { field: "companyAgeYears", operator: "gte", value: 10 } },
];

const DIRECTORS: Preset[] = [
  { value: "none", label: "No directors found", rule: { field: "directorCount", operator: "equals", value: 0 } },
  { value: "single", label: "Single director", rule: { field: "singleDirector", operator: "isTrue", value: true } },
  { value: "2-3", label: "2 – 3 directors", rule: { field: "directorCount", operator: "between", value: 2, value2: 3 } },
  { value: "4+", label: "4+ directors", rule: { field: "directorCount", operator: "gte", value: 4 } },
];

const FILING: Preset[] = [
  { value: "ds01", label: "DS01 filed (strike-off)", rule: { field: "hasDS01", operator: "isTrue", value: true } },
  { value: "late", label: "Late accounts", rule: { field: "accountsOverdue", operator: "isTrue", value: true } },
  { value: "lateCs", label: "Late confirmation statement", rule: { field: "confirmationOverdue", operator: "isTrue", value: true } },
  { value: "dormant", label: "Dormant", rule: { field: "dormant", operator: "isTrue", value: true } },
];

const PRESET_GROUPS: Record<string, Preset[]> = { age: AGE, directors: DIRECTORS, filing: FILING };

const rid = (key: string) => `qf-${key}`;

function current(filter: FilterGroupNode, key: string): FilterRule | undefined {
  return filter.children.find((c): c is FilterRule => c.kind === "rule" && c.id === rid(key));
}

function presetValue(filter: FilterGroupNode, key: string): string {
  const r = current(filter, key);
  if (!r) return "";
  const hit = PRESET_GROUPS[key].find((p) => p.rule.field === r.field && p.rule.operator === r.operator && p.rule.value === r.value && (p.rule.value2 ?? null) === (r.value2 ?? null));
  return hit?.value ?? "";
}

function textValue(filter: FilterGroupNode, key: string): string {
  const r = current(filter, key);
  return typeof r?.value === "string" ? r.value : "";
}

function setRule(filter: FilterGroupNode, key: string, rule: Omit<FilterRule, "id" | "kind"> | null): FilterGroupNode {
  const rest = filter.children.filter((c) => c.id !== rid(key));
  return { ...filter, children: rule ? [...rest, { id: rid(key), kind: "rule", ...rule }] : rest };
}

const controlClass =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function QuickFilters({ filter, onChange }: { filter: FilterGroupNode; onChange: (next: FilterGroupNode) => void }) {
  const select = (key: string, placeholder: string, options: { value: string; label: string }[], onPick: (v: string) => void, value: string) => (
    <select aria-label={placeholder} value={value} onChange={(e) => onPick(e.target.value)} className={`${controlClass} ${value ? "border-indigo-300 bg-indigo-50/40 font-medium" : ""}`}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  const enumRule = (key: "status" | "type") => (v: string) => onChange(setRule(filter, key, v ? { field: key, operator: "equals", value: v } : null));
  const textRule = (key: string, field: string, operator: FilterRule["operator"]) => (v: string) =>
    onChange(setRule(filter, key, v.trim() ? { field, operator, value: v } : null));
  const presetRule = (key: string) => (v: string) => {
    const p = PRESET_GROUPS[key].find((x) => x.value === v);
    onChange(setRule(filter, key, p ? { ...p.rule } : null));
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
      {select("status", "All statuses", COMPANY_STATUS_OPTIONS, enumRule("status"), (current(filter, "status")?.value as string) ?? "")}
      {select("type", "All company types", COMPANY_TYPE_OPTIONS, enumRule("type"), (current(filter, "type")?.value as string) ?? "")}
      <input
        aria-label="City or town"
        placeholder="City / town"
        value={textValue(filter, "city")}
        onChange={(e) => textRule("city", "registeredCity", "contains")(e.target.value)}
        className={controlClass}
      />
      <input
        aria-label="Postcode"
        placeholder="Postcode (e.g. SW1A)"
        value={textValue(filter, "postcode")}
        onChange={(e) => textRule("postcode", "registeredPostcode", "startsWith")(e.target.value)}
        className={controlClass}
      />
      <input
        aria-label="SIC code"
        placeholder="SIC code (e.g. 62012)"
        value={textValue(filter, "sic")}
        onChange={(e) => textRule("sic", "sicCodes", "contains")(e.target.value)}
        className={controlClass}
      />
      {select("age", "Any company age", AGE, presetRule("age"), presetValue(filter, "age"))}
      {select("directors", "Any directors", DIRECTORS, presetRule("directors"), presetValue(filter, "directors"))}
      {select("filing", "Any filing status", FILING, presetRule("filing"), presetValue(filter, "filing"))}
    </div>
  );
}
