"use client";

import { Lock } from "lucide-react";
import { FIELD_CATEGORIES } from "@/lib/columns/catalogue";
import { cn } from "@/lib/cn";

export interface GroupField {
  key: string;
  label: string;
  category: string;
  description?: string;
}

// Compact grouped checkbox panel: one row per category, the category's fields as inline checkboxes, and a
// "Toggle all <category>" box at the end of the row. Used by the Super Admin screen and by the user's column picker.
export function CheckboxGroups({
  fields,
  isChecked,
  isLocked,
  isDisabled,
  isUnavailable,
  onToggle,
  onToggleGroup,
  idPrefix,
}: {
  fields: GroupField[];
  isChecked: (key: string) => boolean;
  // Always-on fields (the Company column): shown ticked and not changeable, and left out of "Toggle all".
  isLocked?: (key: string) => boolean;
  // Temporarily not tickable (for example a column limit has been reached).
  isDisabled?: (key: string) => boolean;
  // Not selectable right now (for example switched off for users): shown unticked and greyed, and left out of "Toggle all".
  isUnavailable?: (key: string) => boolean;
  onToggle: (key: string) => void;
  // Called with the keys that "Toggle all" should change and the state they should take.
  onToggleGroup: (category: string, keys: string[], on: boolean) => void;
  idPrefix: string;
}) {
  const groups = FIELD_CATEGORIES.map((c) => ({ category: c, fields: fields.filter((f) => f.category === c) })).filter((g) => g.fields.length > 0);
  if (groups.length === 0) return <p className="text-sm text-slate-500">Nothing to show.</p>;

  return (
    <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-slate-50/70">
      {groups.map((g) => {
        const toggleable = g.fields.filter((f) => !isLocked?.(f.key) && !isUnavailable?.(f.key));
        const checkedCount = toggleable.filter((f) => isChecked(f.key)).length;
        const all = toggleable.length > 0 && checkedCount === toggleable.length;
        const some = checkedCount > 0 && !all;
        return (
          <div key={g.category} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap">
            <div className="w-full shrink-0 text-xs font-bold uppercase tracking-wide text-slate-600 sm:w-36 sm:pt-0.5">{g.category}:</div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1.5">
              {g.fields.map((f) => {
                const locked = !!isLocked?.(f.key);
                const unavailable = !!isUnavailable?.(f.key);
                const id = `${idPrefix}-${f.key}`;
                return (
                  <label key={f.key} htmlFor={id} title={f.description} className={cn("inline-flex items-center gap-1.5 text-sm", unavailable ? "cursor-not-allowed text-slate-400" : "text-slate-800", locked || unavailable ? "cursor-default" : "cursor-pointer")}>
                    <input
                      id={id}
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300"
                      checked={locked ? true : unavailable ? false : isChecked(f.key)}
                      disabled={locked || unavailable || !!isDisabled?.(f.key)}
                      onChange={() => onToggle(f.key)}
                    />
                    {f.label}
                    {locked && <Lock className="h-3 w-3 text-slate-400" aria-label="Always on" />}
                  </label>
                );
              })}
            </div>
            {toggleable.length > 0 && (
              <label htmlFor={`${idPrefix}-all-${g.category}`} className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-sm font-medium text-indigo-700">
                <input
                  id={`${idPrefix}-all-${g.category}`}
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = some;
                  }}
                  onChange={() =>
                    onToggleGroup(
                      g.category,
                      toggleable.map((f) => f.key),
                      !all
                    )
                  }
                />
                Toggle all {g.category.toLowerCase()}
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
