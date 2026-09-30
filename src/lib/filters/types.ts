// Generic filter/query-builder engine.
//
// The product requirement is "any and all permutation" filters over the
// Companies House dataset. Rather than hard-coding a handful of filter
// combinations, every filterable attribute is declared once in a field
// registry (see fields.ts) and rules/groups are composed into an arbitrary
// AND/OR tree that gets compiled into a Prisma `where` clause at query time.
// New filters are added later by extending the registry + compiler — the
// UI and storage format do not need to change.

export type FieldType = "string" | "number" | "boolean" | "date" | "enum";

export type Operator =
  | "equals"
  | "notEquals"
  | "contains"
  | "startsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "before"
  | "after"
  | "dateBetween"
  | "isTrue"
  | "isFalse"
  | "in";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterFieldDef {
  key: string;
  label: string;
  type: FieldType;
  operators: Operator[];
  options?: FilterOption[];
  group: string;
  description?: string;
  placeholder?: string;
}

export interface FilterRule {
  id: string;
  kind: "rule";
  field: string;
  operator: Operator;
  value?: string | number | boolean | null;
  value2?: string | number | null;
}

export interface FilterGroupNode {
  id: string;
  kind: "group";
  combinator: "AND" | "OR";
  children: FilterNode[];
}

export type FilterNode = FilterRule | FilterGroupNode;

export function emptyFilterGroup(): FilterGroupNode {
  return {
    id: makeId(),
    kind: "group",
    combinator: "AND",
    children: [],
  };
}

export function emptyRule(field: string, operator: Operator): FilterRule {
  return {
    id: makeId(),
    kind: "rule",
    field,
    operator,
    value: "",
  };
}

export function makeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function countActiveRules(node: FilterNode): number {
  if (node.kind === "rule") {
    return node.value !== "" && node.value !== null && node.value !== undefined ? 1 : 0;
  }
  return node.children.reduce((sum, child) => sum + countActiveRules(child), 0);
}
