import type { Prisma } from "@prisma/client";
import type { FilterNode, FilterRule, Operator } from "./types";

function yearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

// NOTE: `mode: "insensitive"` is Postgres/Mongo-only in Prisma; SQLite's
// LIKE is already case-insensitive for ASCII, so it's omitted here for
// dev-db compatibility. Re-add it once the datasource is switched to
// Postgres in production.
function stringCondition(operator: Operator, value: unknown) {
  const v = String(value ?? "");
  switch (operator) {
    case "equals":
      return { equals: v };
    case "contains":
      return { contains: v };
    case "startsWith":
      return { startsWith: v };
    default:
      return undefined;
  }
}

function compileRule(rule: FilterRule): Prisma.CompanyWhereInput | null {
  const { field, operator, value, value2 } = rule;
  if (value === "" || value === null || value === undefined) {
    if (operator !== "isTrue" && operator !== "isFalse") return null;
  }

  // Derived field: convert age (years) into an incorporationDate range.
  if (field === "companyAgeYears") {
    const num = Number(value);
    switch (operator) {
      case "gt":
        return { incorporationDate: { lt: yearsAgo(num) } };
      case "gte":
        return { incorporationDate: { lte: yearsAgo(num) } };
      case "lt":
        return { incorporationDate: { gt: yearsAgo(num) } };
      case "lte":
        return { incorporationDate: { gte: yearsAgo(num) } };
      case "between": {
        const num2 = Number(value2 ?? num);
        const [minAge, maxAge] = num <= num2 ? [num, num2] : [num2, num];
        return {
          incorporationDate: { gte: yearsAgo(maxAge), lte: yearsAgo(minAge) },
        };
      }
      default:
        return null;
    }
  }

  switch (operator) {
    case "isTrue":
      return { [field]: true } as Prisma.CompanyWhereInput;
    case "isFalse":
      return { [field]: false } as Prisma.CompanyWhereInput;
    case "equals": {
      if (field === "status" || field === "type") {
        return { [field]: value } as Prisma.CompanyWhereInput;
      }
      return { [field]: stringCondition("equals", value) } as Prisma.CompanyWhereInput;
    }
    case "notEquals":
      return { [field]: { not: value } } as Prisma.CompanyWhereInput;
    case "contains":
    case "startsWith":
      return { [field]: stringCondition(operator, value) } as Prisma.CompanyWhereInput;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [field]: { [operator]: Number(value) } } as Prisma.CompanyWhereInput;
    case "between": {
      const a = Number(value);
      const b = Number(value2 ?? value);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return { [field]: { gte: lo, lte: hi } } as Prisma.CompanyWhereInput;
    }
    case "before":
      return { [field]: { lt: new Date(String(value)) } } as Prisma.CompanyWhereInput;
    case "after":
      return { [field]: { gt: new Date(String(value)) } } as Prisma.CompanyWhereInput;
    case "dateBetween": {
      const from = new Date(String(value));
      const to = new Date(String(value2 ?? value));
      return { [field]: { gte: from, lte: to } } as Prisma.CompanyWhereInput;
    }
    default:
      return null;
  }
}

export function compileFilterNode(node: FilterNode): Prisma.CompanyWhereInput | null {
  if (node.kind === "rule") return compileRule(node);

  const compiledChildren = node.children
    .map((child) => compileFilterNode(child))
    .filter((c): c is Prisma.CompanyWhereInput => c !== null);

  if (compiledChildren.length === 0) return null;
  if (compiledChildren.length === 1) return compiledChildren[0];

  return node.combinator === "OR" ? { OR: compiledChildren } : { AND: compiledChildren };
}

export function compileFilterToWhere(node: FilterNode | null | undefined): Prisma.CompanyWhereInput {
  if (!node) return {};
  return compileFilterNode(node) ?? {};
}
