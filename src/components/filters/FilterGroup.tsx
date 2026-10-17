"use client";

import { Plus, FolderPlus, Trash2 } from "lucide-react";
import type { FilterGroupNode, FilterNode } from "@/lib/filters/types";
import { emptyRule, emptyFilterGroup } from "@/lib/filters/types";
import { COMPANY_FILTER_FIELDS } from "@/lib/filters/fields";
import { FilterRuleRow } from "./FilterRuleRow";
import { cn } from "@/lib/cn";

export function FilterGroupEditor({
  group,
  onChange,
  onRemove,
  depth = 0,
}: {
  group: FilterGroupNode;
  onChange: (group: FilterGroupNode) => void;
  onRemove?: () => void;
  depth?: number;
}) {
  function updateChild(index: number, next: FilterNode) {
    const children = [...group.children];
    children[index] = next;
    onChange({ ...group, children });
  }

  function removeChild(index: number) {
    const children = group.children.filter((_, i) => i !== index);
    onChange({ ...group, children });
  }

  function addRule() {
    const first = COMPANY_FILTER_FIELDS[0];
    onChange({ ...group, children: [...group.children, emptyRule(first.key, first.operators[0])] });
  }

  function addGroup() {
    onChange({ ...group, children: [...group.children, emptyFilterGroup()] });
  }

  const isAll = group.combinator === "AND";
  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        depth === 0 ? "border-slate-200 bg-slate-50/60" : "border-l-4 border-indigo-200 border-l-indigo-400 bg-indigo-50/40"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
          {depth > 0 && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700">Group</span>}
          Match
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300" role="group" aria-label="How conditions combine">
            {(
              [
                { c: "AND", label: "ALL", hint: "Every condition must be true (AND)" },
                { c: "OR", label: "ANY", hint: "At least one condition must be true (OR)" },
              ] as const
            ).map(({ c, label, hint }) => (
              <button
                key={c}
                type="button"
                title={hint}
                aria-pressed={group.combinator === c}
                onClick={() => onChange({ ...group, combinator: c })}
                className={cn(
                  "px-2.5 py-1 text-xs font-semibold",
                  group.combinator === c ? "bg-indigo-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >
                {label} <span className="font-normal opacity-80">({c})</span>
              </button>
            ))}
          </div>
          <span className="font-normal text-slate-500">
            {isAll ? "of these conditions — every one must be true" : "of these conditions — at least one must be true"}
          </span>
        </div>
        {onRemove && depth > 0 && (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 rounded-md p-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove group"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove group
          </button>
        )}
      </div>

      <div className="space-y-2">
        {group.children.map((child, i) => (
          <div key={child.id} className="space-y-2">
            {i > 0 && (
              <div className="flex items-center gap-2" aria-hidden>
                <span className="h-px flex-1 bg-slate-200" />
                <span className="rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold tracking-wider text-slate-600">{group.combinator}</span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
            )}
            {child.kind === "rule" ? (
              <FilterRuleRow rule={child} onChange={(next) => updateChild(i, next)} onRemove={() => removeChild(i)} />
            ) : (
              <FilterGroupEditor
                group={child}
                depth={depth + 1}
                onChange={(next) => updateChild(i, next)}
                onRemove={() => removeChild(i)}
              />
            )}
          </div>
        ))}
        {group.children.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-400">
            No conditions yet — add a condition below.
          </p>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={addRule}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add condition
        </button>
        <button
          type="button"
          onClick={addGroup}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <FolderPlus className="h-3.5 w-3.5" /> Add group (nested AND / OR)
        </button>
      </div>
    </div>
  );
}
