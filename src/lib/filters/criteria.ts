import { getFieldDef } from "./fields";
import { makeId } from "./types";
import type { FilterGroupNode, FilterNode, FilterRule, Operator } from "./types";

// Presentation helpers for the visual criteria panel in the report builder.
//
// The panel does NOT keep its own state: every control reads from and writes to the SAME filter tree the
// AND/OR logic builder edits. A control "owns" the first top-level node for its field:
//   - a plain rule on that field, or
//   - for checkbox-style enum fields, an OR group of `equals` rules on that field (ticking several statuses
//     means "Active OR Dissolved", which the existing compiler already supports).
// Anything the panel cannot represent faithfully (e.g. "age greater than 5") stays in the tree untouched and is
// reported as `custom`, so loading a saved report never loses or rewrites a condition.

const blank = (v: unknown) => v === undefined || v === null || v === "";

function isEnumGroup(node: FilterNode, key: string): node is FilterGroupNode {
  return (
    node.kind === "group" &&
    node.combinator === "OR" &&
    node.children.length > 0 &&
    node.children.every((c) => c.kind === "rule" && c.field === key && c.operator === "equals")
  );
}

function ownedIndex(root: FilterGroupNode, key: string): number {
  return root.children.findIndex((c) => (c.kind === "rule" ? c.field === key : isEnumGroup(c, key)));
}

export function ownedNode(root: FilterGroupNode, key: string): FilterNode | undefined {
  return root.children[ownedIndex(root, key)];
}

function put(root: FilterGroupNode, key: string, next: FilterNode | null): FilterGroupNode {
  const i = ownedIndex(root, key);
  const children = [...root.children];
  if (i === -1) {
    if (next) children.push(next);
  } else if (next) children[i] = next;
  else children.splice(i, 1);
  return { ...root, children };
}

export function removeTopLevel(root: FilterGroupNode, id: string): FilterGroupNode {
  return { ...root, children: root.children.filter((c) => c.id !== id) };
}

// ---- checkbox options (enum fields) ----
export function getChecked(root: FilterGroupNode, key: string): string[] {
  const node = ownedNode(root, key);
  if (!node) return [];
  if (node.kind === "rule") return node.operator === "equals" && !blank(node.value) ? [String(node.value)] : [];
  return node.children.flatMap((c) => (c.kind === "rule" && !blank(c.value) ? [String(c.value)] : []));
}

export function setChecked(root: FilterGroupNode, key: string, values: string[]): FilterGroupNode {
  const existing = ownedNode(root, key);
  if (values.length === 0) return put(root, key, null);
  const rule = (value: string): FilterRule => ({ id: makeId(), kind: "rule", field: key, operator: "equals", value });
  if (values.length === 1) {
    const keep = existing?.kind === "rule" ? existing.id : makeId();
    return put(root, key, { ...rule(values[0]), id: keep });
  }
  const group: FilterGroupNode = {
    id: existing?.kind === "group" ? existing.id : makeId(),
    kind: "group",
    combinator: "OR",
    children: values.map(rule),
  };
  return put(root, key, group);
}

// ---- yes / no (boolean fields) ----
export function getBool(root: FilterGroupNode, key: string): "yes" | "no" | null {
  const node = ownedNode(root, key);
  if (!node || node.kind !== "rule") return null;
  return node.operator === "isFalse" ? "no" : "yes";
}

export function setBool(root: FilterGroupNode, key: string, state: "yes" | "no" | null): FilterGroupNode {
  if (!state) return put(root, key, null);
  const existing = ownedNode(root, key);
  const node: FilterRule = {
    id: existing?.id ?? makeId(),
    kind: "rule",
    field: key,
    operator: state === "yes" ? "isTrue" : "isFalse",
    value: state === "yes",
  };
  return put(root, key, node);
}

// ---- ranges (number: min/max, date: from/to) ----
export interface Range {
  from: string;
  to: string;
  custom: boolean; // a rule exists that min/max cannot express (equals / gt / lt) - left to the logic builder
}

const LOW: Record<string, Operator> = { number: "gte", date: "after" };
const HIGH: Record<string, Operator> = { number: "lte", date: "before" };
const BOTH: Record<string, Operator> = { number: "between", date: "dateBetween" };

export function getRange(root: FilterGroupNode, key: string): Range {
  const def = getFieldDef(key);
  const node = ownedNode(root, key);
  if (!def || !node || node.kind !== "rule") return { from: "", to: "", custom: false };
  const v = blank(node.value) ? "" : String(node.value);
  const v2 = blank(node.value2) ? "" : String(node.value2);
  if (node.operator === BOTH[def.type]) return { from: v, to: v2 || v, custom: false };
  if (node.operator === LOW[def.type]) return { from: v, to: "", custom: false };
  if (node.operator === HIGH[def.type]) return { from: "", to: v, custom: false };
  return { from: "", to: "", custom: !blank(node.value) };
}

export function setRange(root: FilterGroupNode, key: string, from: string, to: string): FilterGroupNode {
  const def = getFieldDef(key);
  if (!def) return root;
  if (blank(from) && blank(to)) return put(root, key, null);
  const id = ownedNode(root, key)?.id ?? makeId();
  const rule = (operator: Operator, value: string, value2?: string): FilterRule => ({
    id,
    kind: "rule",
    field: key,
    operator,
    value,
    ...(value2 !== undefined ? { value2 } : {}),
  });
  if (!blank(from) && !blank(to)) return put(root, key, rule(BOTH[def.type], from, to));
  return put(root, key, !blank(from) ? rule(LOW[def.type], from) : rule(HIGH[def.type], to));
}

// ---- free text ----
export function getText(root: FilterGroupNode, key: string): { operator: Operator; value: string } {
  const def = getFieldDef(key);
  const node = ownedNode(root, key);
  if (node && node.kind === "rule") return { operator: node.operator, value: blank(node.value) ? "" : String(node.value) };
  return { operator: def?.operators[0] ?? "contains", value: "" };
}

export function setText(root: FilterGroupNode, key: string, operator: Operator, value: string): FilterGroupNode {
  const existing = ownedNode(root, key);
  if (blank(value)) {
    // Operator picked before typing keeps an inert (blank) rule so the choice is remembered; clearing the text removes it.
    if (existing?.kind === "rule" && blank(existing.value)) return put(root, key, { ...existing, operator });
    if (!existing) return put(root, key, { id: makeId(), kind: "rule", field: key, operator, value: "" });
    return put(root, key, null);
  }
  return put(root, key, { id: existing?.id ?? makeId(), kind: "rule", field: key, operator, value });
}

export function clearFields(root: FilterGroupNode, keys: string[]): FilterGroupNode {
  return keys.reduce((acc, k) => {
    let next = acc;
    // a field can own several top-level nodes; drop every one the panel could have created
    for (let guard = 0; guard < 20 && ownedIndex(next, k) !== -1; guard++) next = put(next, k, null);
    return next;
  }, root);
}

export function isActive(root: FilterGroupNode, key: string): boolean {
  const node = ownedNode(root, key);
  if (!node) return false;
  if (node.kind === "group") return getChecked(root, key).length > 0;
  return node.operator === "isTrue" || node.operator === "isFalse" || !blank(node.value);
}
