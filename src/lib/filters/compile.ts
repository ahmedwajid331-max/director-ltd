import type { Prisma } from "@prisma/client";
import type { FilterNode, FilterRule } from "./types";
import { parseFilterOrThrow } from "./validate";

// Compiles a *validated* filter tree (see validate.ts) into a Prisma where
// clause for PostgreSQL. Never call compileFilterNode with raw user input -
// use compileFilterToWhere, which validates first.

// Calendar-date semantics: "today" is the current UTC calendar date at
// midnight, never the current instant. A company incorporated on
// 2016-09-30 is exactly 10 years old on 2026-09-30, at any time of day.
export function utcToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function yearsBefore(today: Date, years: number): Date {
  const whole = Math.trunc(years);
  const d = new Date(Date.UTC(today.getUTCFullYear() - whole, today.getUTCMonth(), today.getUTCDate()));
  // 29 Feb minus N years that is not a leap year rolls to 1 Mar; clamp to 28 Feb.
  if (d.getUTCMonth() !== today.getUTCMonth()) d.setUTCDate(0);
  return d;
}

function str(field: string, operator: "equals" | "contains" | "startsWith", value: string): Prisma.CompanyWhereInput {
  // Postcodes are stored upper-case, so prefix search stays case-sensitive
  // (and can use the text_pattern_ops index); everything else is
  // case-insensitive (ILIKE, served by the pg_trgm GIN indexes).
  if (field === "registeredPostcode") {
    return { [field]: { [operator]: value.toUpperCase() } } as Prisma.CompanyWhereInput;
  }
  if (field === "companyNumber") {
    return { [field]: { [operator]: value.toUpperCase() } } as Prisma.CompanyWhereInput;
  }
  return { [field]: { [operator]: value, mode: "insensitive" } } as Prisma.CompanyWhereInput;
}

function compileRule(rule: FilterRule, now: Date): Prisma.CompanyWhereInput | null {
  const { field, operator, value, value2 } = rule;
  if (operator === "isTrue") return { [field]: true } as Prisma.CompanyWhereInput;
  if (operator === "isFalse") return { [field]: false } as Prisma.CompanyWhereInput;
  if (value === "" || value === null || value === undefined) return null; // inactive rule

  if (field === "companyAgeYears") {
    const today = utcToday(now);
    const n = Number(value);
    switch (operator) {
      case "gt":
        return { incorporationDate: { lt: yearsBefore(today, n) } };
      case "gte":
        return { incorporationDate: { lte: yearsBefore(today, n) } };
      case "lt":
        return { incorporationDate: { gt: yearsBefore(today, n) } };
      case "lte":
        return { incorporationDate: { gte: yearsBefore(today, n) } };
      case "between": {
        const n2 = Number(value2 ?? n);
        const [lo, hi] = n <= n2 ? [n, n2] : [n2, n];
        return { incorporationDate: { gte: yearsBefore(today, hi), lte: yearsBefore(today, lo) } };
      }
      default:
        return null;
    }
  }

  switch (operator) {
    case "equals":
      if (typeof value === "number") return { [field]: value } as Prisma.CompanyWhereInput; // numeric "is exactly N"
      if (field === "status" || field === "type") return { [field]: String(value) } as Prisma.CompanyWhereInput;
      return str(field, "equals", String(value));
    case "contains":
    case "startsWith":
      return str(field, operator, String(value));
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [field]: { [operator]: Number(value) } } as Prisma.CompanyWhereInput;
    case "between": {
      const a = Number(value);
      const b = Number(value2 ?? value);
      return { [field]: { gte: Math.min(a, b), lte: Math.max(a, b) } } as Prisma.CompanyWhereInput;
    }
    case "before":
      return { [field]: { lt: new Date(`${value}T00:00:00.000Z`) } } as Prisma.CompanyWhereInput;
    case "after":
      return { [field]: { gt: new Date(`${value}T00:00:00.000Z`) } } as Prisma.CompanyWhereInput;
    case "dateBetween": {
      const a = new Date(`${value}T00:00:00.000Z`);
      const b = new Date(`${value2 ?? value}T00:00:00.000Z`);
      return { [field]: { gte: a <= b ? a : b, lte: a <= b ? b : a } } as Prisma.CompanyWhereInput;
    }
    default:
      return null;
  }
}

export function compileFilterNode(node: FilterNode, now: Date = new Date()): Prisma.CompanyWhereInput | null {
  if (node.kind === "rule") return compileRule(node, now);

  const compiledChildren = node.children
    .map((child) => compileFilterNode(child, now))
    .filter((c): c is Prisma.CompanyWhereInput => c !== null);

  if (compiledChildren.length === 0) return null;
  if (compiledChildren.length === 1) return compiledChildren[0];
  return node.combinator === "OR" ? { OR: compiledChildren } : { AND: compiledChildren };
}

// Validates (throws FilterValidationError on bad input) then compiles.
export function compileFilterToWhere(input: unknown, now: Date = new Date()): Prisma.CompanyWhereInput {
  const node = parseFilterOrThrow(input);
  if (!node) return {};
  return compileFilterNode(node, now) ?? {};
}
