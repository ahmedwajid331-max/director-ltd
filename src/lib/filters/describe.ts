import { OPERATOR_LABELS, getFieldDef } from "./fields";
import type { FilterNode, FilterRule } from "./types";

// Plain-English wording for a filter, used by the active-filter chips and the report archive.
// Presentation only: it never changes what a filter matches.
export function describeRule(rule: FilterRule): string | null {
  const field = getFieldDef(rule.field);
  if (!field) return null;
  if (field.type === "boolean") {
    return `${field.label}: ${rule.operator === "isFalse" ? "No" : "Yes"}`;
  }
  if (rule.value === "" || rule.value === null || rule.value === undefined) return null;
  const option = field.options?.find((o) => o.value === rule.value);
  const value = option ? option.label : String(rule.value);
  const op = OPERATOR_LABELS[rule.operator] ?? rule.operator;
  const second = rule.value2 !== undefined && rule.value2 !== null && rule.value2 !== "" ? ` and ${rule.value2}` : "";
  return `${field.label} ${op} ${value}${second}`;
}

// "Dormant: Yes AND Status is Active" - nested groups are parenthesised, ALL = AND, ANY = OR.
export function describeFilter(node: FilterNode | null | undefined, top = true): string {
  if (!node) return "";
  if (node.kind === "rule") return describeRule(node) ?? "";
  const parts = node.children.map((c) => describeFilter(c, false)).filter(Boolean);
  if (parts.length === 0) return "";
  const joined = parts.join(` ${node.combinator} `);
  return top || parts.length === 1 ? joined : `(${joined})`;
}

// Top-level rules flattened for removable chips (nested groups stay in the editor).
export function topLevelRules(group: { children: FilterNode[] }): FilterRule[] {
  return group.children.filter((c): c is FilterRule => c.kind === "rule" && describeRule(c) !== null);
}
