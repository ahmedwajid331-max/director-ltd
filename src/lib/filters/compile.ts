import type { Prisma } from "@prisma/client";
import type { FilterNode, FilterRule } from "./types";
import { parseFilterOrThrow } from "./validate";
import { isNameLetter, nameLetterConditions } from "./nameLetter";

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

// directorCount / singleDirector default to 0 / false until officers are
// fetched, so on their own they cannot tell "no directors" from "not fetched".
// Director rules therefore only match companies with confirmed (full) officer
// coverage; none / unavailable companies never qualify, whatever the operator.
const OFFICER_DERIVED_FIELDS = new Set(["directorCount", "singleDirector"]);

// Two compilations of the same filter tree (three-valued logic: a director
// rule on a company without confirmed officer data is UNKNOWN, not false):
//   "confirmed" - the filter evaluates TRUE. These are the results.
//   "possible"  - the filter does not evaluate FALSE (TRUE or UNKNOWN): a
//                 director rule also admits every company whose officers are
//                 not confirmed. possible - confirmed = the companies that
//                 could not be evaluated yet. confirmed is always a subset of
//                 possible, so the unknown count is a plain count difference.
export type CompileMode = "confirmed" | "possible";

// Per-user CRM flags live on UserCompanyState, one row per (user, company). A CRM rule compiles to an indexed
// relation filter on THAT user's row only, never another user's: "Saved = Yes" is `some state of this user with
// saved`, "Saved = No" is its negation (a company with no state row is simply not saved). Without a user there is
// no CRM state, so Yes matches nothing and No matches everything.
const CRM_FIELDS = new Set(["followed", "saved", "redFlagged"]);

function compileCrmRule(rule: FilterRule, userId: string | undefined): Prisma.CompanyWhereInput | null {
  if (rule.operator !== "isTrue" && rule.operator !== "isFalse") return null;
  const wantsTrue = rule.operator === "isTrue";
  if (!userId) return wantsTrue ? { id: "__no-user__" } : {};
  const has: Prisma.CompanyWhereInput = { userStates: { some: { userId, [rule.field]: true } } };
  return wantsTrue ? has : { NOT: has };
}

function compileRule(rule: FilterRule, now: Date, mode: CompileMode, userId?: string): Prisma.CompanyWhereInput | null {
  if (CRM_FIELDS.has(rule.field)) return compileCrmRule(rule, userId);
  const where = compileRuleValue(rule, now);
  if (!where || !OFFICER_DERIVED_FIELDS.has(rule.field)) return where;
  const confirmed: Prisma.CompanyWhereInput = { AND: [{ officersCoverage: "full" }, where] };
  return mode === "confirmed" ? confirmed : { OR: [{ officersCoverage: { not: "full" } }, confirmed] };
}

function compileRuleValue(rule: FilterRule, now: Date): Prisma.CompanyWhereInput | null {
  const { field, operator, value, value2 } = rule;
  if (operator === "isTrue") return { [field]: true } as Prisma.CompanyWhereInput;
  if (operator === "isFalse") return { [field]: false } as Prisma.CompanyWhereInput;
  if (value === "" || value === null || value === undefined) return null; // inactive rule

  if (field === "nameLetter") {
    return operator === "equals" && isNameLetter(value) ? { AND: nameLetterConditions(String(value)) } : null;
  }

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

export function compileFilterNode(node: FilterNode, now: Date = new Date(), mode: CompileMode = "confirmed", userId?: string): Prisma.CompanyWhereInput | null {
  if (node.kind === "rule") return compileRule(node, now, mode, userId);

  const compiledChildren = node.children
    .map((child) => compileFilterNode(child, now, mode, userId))
    .filter((c): c is Prisma.CompanyWhereInput => c !== null);

  if (compiledChildren.length === 0) return null;
  if (compiledChildren.length === 1) return compiledChildren[0];
  return node.combinator === "OR" ? { OR: compiledChildren } : { AND: compiledChildren };
}

// Validates (throws FilterValidationError on bad input) then compiles.
export function compileFilterToWhere(input: unknown, now: Date = new Date(), mode: CompileMode = "confirmed", userId?: string): Prisma.CompanyWhereInput {
  const node = parseFilterOrThrow(input);
  if (!node) return {};
  return compileFilterNode(node, now, mode, userId) ?? {};
}

// True when the filter contains at least one ACTIVE director rule
// (directorCount / singleDirector with a usable value), i.e. when its results
// depend on officer coverage and an unknown count is meaningful.
export function hasActiveDirectorRules(input: unknown, now: Date = new Date()): boolean {
  const node = parseFilterOrThrow(input);
  if (!node) return false;
  const walk = (n: FilterNode): boolean =>
    n.kind === "rule" ? OFFICER_DERIVED_FIELDS.has(n.field) && compileRuleValue(n, now) !== null : n.children.some(walk);
  return walk(node);
}
