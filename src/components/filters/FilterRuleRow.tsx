"use client";

import { Trash2 } from "lucide-react";
import { COMPANY_FILTER_FIELDS, OPERATOR_LABELS, getFieldDef } from "@/lib/filters/fields";
import type { FilterRule, Operator } from "@/lib/filters/types";
import { Select, Input } from "@/components/ui/Input";

export function FilterRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}) {
  const field = getFieldDef(rule.field) ?? COMPANY_FILTER_FIELDS[0];
  const needsValue2 = rule.operator === "between" || rule.operator === "dateBetween";
  const isBoolean = field.type === "boolean";

  function handleFieldChange(key: string) {
    const nextField = getFieldDef(key)!;
    onChange({
      ...rule,
      field: key,
      operator: nextField.operators[0],
      value: nextField.type === "boolean" ? true : "",
      value2: null,
    });
  }

  function handleOperatorChange(operator: Operator) {
    onChange({ ...rule, operator, value: operator === "isTrue" ? true : operator === "isFalse" ? false : rule.value });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <Select
        value={rule.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        className="w-auto min-w-[160px] flex-none"
      >
        {Object.entries(
          COMPANY_FILTER_FIELDS.reduce<Record<string, typeof COMPANY_FILTER_FIELDS>>((groups, f) => {
            (groups[f.group] ??= []).push(f);
            return groups;
          }, {})
        ).map(([group, fields]) => (
          <optgroup key={group} label={group}>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>

      {!isBoolean && (
        <Select
          value={rule.operator}
          onChange={(e) => handleOperatorChange(e.target.value as Operator)}
          className="w-auto min-w-[130px] flex-none"
        >
          {field.operators.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </option>
          ))}
        </Select>
      )}

      {isBoolean ? (
        <Select
          value={rule.operator}
          onChange={(e) => handleOperatorChange(e.target.value as Operator)}
          className="w-auto min-w-[90px] flex-none"
        >
          <option value="isTrue">Yes</option>
          <option value="isFalse">No</option>
        </Select>
      ) : field.type === "enum" ? (
        <Select
          value={String(rule.value ?? "")}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="w-auto min-w-[160px] flex-1"
        >
          <option value="" disabled>
            Select…
          </option>
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      ) : field.type === "date" ? (
        <div className="flex flex-1 items-center gap-2">
          <Input
            type="date"
            value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            className="min-w-[150px] flex-1"
          />
          {needsValue2 && (
            <>
              <span className="text-xs text-slate-400">and</span>
              <Input
                type="date"
                value={String(rule.value2 ?? "")}
                onChange={(e) => onChange({ ...rule, value2: e.target.value })}
                className="min-w-[150px] flex-1"
              />
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center gap-2">
          <Input
            type={field.type === "number" ? "number" : "text"}
            value={String(rule.value ?? "")}
            placeholder={field.placeholder}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            className="min-w-[140px] flex-1"
          />
          {needsValue2 && (
            <>
              <span className="text-xs text-slate-400">and</span>
              <Input
                type="number"
                value={String(rule.value2 ?? "")}
                onChange={(e) => onChange({ ...rule, value2: e.target.value })}
                className="min-w-[100px] flex-1"
              />
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="ml-auto rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
        aria-label="Remove filter"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
