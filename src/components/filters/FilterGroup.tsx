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

  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border p-3",
        depth === 0 ? "border-slate-200 bg-slate-50/50" : "border-indigo-100 bg-indigo-50/30"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          Match
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
            {(["AND", "OR"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onChange({ ...group, combinator: c })}
                className={cn(
                  "px-2.5 py-1 text-xs font-semibold",
                  group.combinator === c ? "bg-indigo-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >
                {c}
              </button>
            ))}
          </div>
          of the following
        </div>
        {onRemove && depth > 0 && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove group"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="space-y-2">
        {group.children.map((child, i) =>
          child.kind === "rule" ? (
            <FilterRuleRow
              key={child.id}
              rule={child}
              onChange={(next) => updateChild(i, next)}
              onRemove={() => removeChild(i)}
            />
          ) : (
            <FilterGroupEditor
              key={child.id}
              group={child}
              depth={depth + 1}
              onChange={(next) => updateChild(i, next)}
              onRemove={() => removeChild(i)}
            />
          )
        )}
        {group.children.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-400">
            No conditions yet — add a filter below.
          </p>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={addRule}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add filter
        </button>
        <button
          type="button"
          onClick={addGroup}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <FolderPlus className="h-3.5 w-3.5" /> Add group
        </button>
      </div>
    </div>
  );
}
