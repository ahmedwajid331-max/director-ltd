import { COMPANY_STATUS_OPTIONS, getFieldDef } from "./fields";
import type { FilterNode, FilterRule } from "./types";

// Every filter that reaches the database first passes through here. Anything
// not explicitly allowed by the field registry (unknown field, operator not
// offered for that field, NaN, impossible date, oversized/deeply nested
// tree...) is rejected with a readable message instead of reaching Prisma.
// The result is a *normalised* tree (numbers are real numbers, dates are
// checked YYYY-MM-DD strings) that compile.ts can trust.

export const MAX_FILTER_DEPTH = 6;
export const MAX_FILTER_NODES = 60;
const MAX_STRING_LENGTH = 200;

export class FilterValidationError extends Error {
  constructor(public details: string[]) {
    super(`Invalid filter: ${details.join("; ")}`);
  }
}

export type ParsedFilter = { ok: true; filter: FilterNode | null } | { ok: false; errors: string[] };

const STATUS_VALUES = new Set(COMPANY_STATUS_OPTIONS.map((o) => o.value));
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

function toFinite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

interface Ctx {
  errors: string[];
  nodes: number;
}

function validateRule(raw: Record<string, unknown>, path: string, ctx: Ctx): FilterRule | null {
  const field = typeof raw.field === "string" ? raw.field : "";
  const def = getFieldDef(field);
  if (!def) {
    ctx.errors.push(`${path}: unknown filter field "${String(raw.field).slice(0, 40)}"`);
    return null;
  }
  const operator = raw.operator as FilterRule["operator"];
  if (typeof operator !== "string" || !def.operators.includes(operator)) {
    ctx.errors.push(`${path}: operator "${String(raw.operator).slice(0, 20)}" is not allowed for ${def.label}`);
    return null;
  }

  const base = { id: typeof raw.id === "string" ? raw.id.slice(0, 64) : "", kind: "rule" as const, field, operator };

  if (operator === "isTrue" || operator === "isFalse") return { ...base, value: operator === "isTrue" };

  // A rule the user has not filled in yet is inactive (matches the UI, which
  // shows "N active rules"); it is dropped by the compiler, not an error.
  if (isBlank(raw.value)) return { ...base, value: "" };

  const isRange = operator === "between" || operator === "dateBetween";
  const value2Raw = isBlank(raw.value2) ? raw.value : raw.value2;

  switch (def.type) {
    case "number": {
      const a = toFinite(raw.value);
      const b = isRange ? toFinite(value2Raw) : null;
      if (a === null || (isRange && b === null)) {
        ctx.errors.push(`${path}: ${def.label} needs a number`);
        return null;
      }
      const limit = field === "companyAgeYears" ? 300 : 1_000_000;
      for (const n of isRange ? [a, b as number] : [a]) {
        if (n < 0 || n > limit) {
          ctx.errors.push(`${path}: ${def.label} must be between 0 and ${limit}`);
          return null;
        }
        if (field === "directorCount" && !Number.isInteger(n)) {
          ctx.errors.push(`${path}: ${def.label} must be a whole number`);
          return null;
        }
      }
      return isRange ? { ...base, value: a, value2: b } : { ...base, value: a };
    }
    case "date": {
      const a = String(raw.value);
      const b = String(value2Raw);
      if (!isRealIsoDate(a) || (isRange && !isRealIsoDate(b))) {
        ctx.errors.push(`${path}: ${def.label} needs a real date in YYYY-MM-DD format`);
        return null;
      }
      return isRange ? { ...base, value: a, value2: b } : { ...base, value: a };
    }
    case "enum": {
      const v = String(raw.value);
      const ok = field === "status" ? STATUS_VALUES.has(v) : SLUG.test(v);
      if (!ok) {
        ctx.errors.push(`${path}: "${v.slice(0, 40)}" is not a valid ${def.label}`);
        return null;
      }
      return { ...base, value: v };
    }
    case "string": {
      if (typeof raw.value !== "string" && typeof raw.value !== "number") {
        ctx.errors.push(`${path}: ${def.label} needs text`);
        return null;
      }
      const v = String(raw.value).trim();
      if (v.length > MAX_STRING_LENGTH) {
        ctx.errors.push(`${path}: ${def.label} is too long`);
        return null;
      }
      return { ...base, value: v };
    }
    default:
      ctx.errors.push(`${path}: unsupported field type`);
      return null;
  }
}

function validateNode(raw: unknown, path: string, depth: number, ctx: Ctx): FilterNode | null {
  if (++ctx.nodes > MAX_FILTER_NODES) {
    if (ctx.nodes === MAX_FILTER_NODES + 1) ctx.errors.push(`filter has more than ${MAX_FILTER_NODES} conditions`);
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.errors.push(`${path}: not a valid filter node`);
    return null;
  }
  const node = raw as Record<string, unknown>;

  if (node.kind === "rule") return validateRule(node, path, ctx);

  if (node.kind === "group") {
    if (depth >= MAX_FILTER_DEPTH) {
      ctx.errors.push(`${path}: groups are nested more than ${MAX_FILTER_DEPTH} levels deep`);
      return null;
    }
    if (node.combinator !== "AND" && node.combinator !== "OR") {
      ctx.errors.push(`${path}: combinator must be AND or OR`);
      return null;
    }
    if (!Array.isArray(node.children)) {
      ctx.errors.push(`${path}: group needs a children list`);
      return null;
    }
    const children: FilterNode[] = [];
    node.children.forEach((child, i) => {
      const parsed = validateNode(child, `${path}.children[${i}]`, depth + 1, ctx);
      if (parsed) children.push(parsed);
    });
    return { id: typeof node.id === "string" ? node.id.slice(0, 64) : "", kind: "group", combinator: node.combinator, children };
  }

  ctx.errors.push(`${path}: node kind must be "rule" or "group"`);
  return null;
}

// null/undefined means "no filter" (everything). Anything else must be a
// well-formed tree.
export function parseFilter(input: unknown): ParsedFilter {
  if (input === null || input === undefined) return { ok: true, filter: null };
  const ctx: Ctx = { errors: [], nodes: 0 };
  const filter = validateNode(input, "filter", 0, ctx);
  if (ctx.errors.length > 0 || !filter) return { ok: false, errors: ctx.errors.length ? ctx.errors : ["filter is not valid"] };
  return { ok: true, filter };
}

export function parseFilterOrThrow(input: unknown): FilterNode | null {
  const parsed = parseFilter(input);
  if (!parsed.ok) throw new FilterValidationError(parsed.errors);
  return parsed.filter;
}
