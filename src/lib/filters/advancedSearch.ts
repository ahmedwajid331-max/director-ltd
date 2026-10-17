import { COMPANY_STATUS_OPTIONS, COMPANY_TYPE_OPTIONS } from "./fields";
import { emptyFilterGroup, makeId, type FilterGroupNode, type FilterNode, type FilterRule, type Operator } from "./types";
import { isRealIsoDate } from "./validate";

// The Advanced Company Search form, as plain data. It is turned into the SAME filter tree the Report Builder and the
// Companies page use, so results, counts, export and saved reports all go through one query path.
export interface AdvancedForm {
  name: string;
  address: string;
  postcode: string;
  incFrom: string;
  incTo: string;
  statuses: string[];
  sic: string;
  types: string[];
  dissFrom: string;
  dissTo: string;
}

export const EMPTY_FORM: AdvancedForm = { name: "", address: "", postcode: "", incFrom: "", incTo: "", statuses: [], sic: "", types: [], dissFrom: "", dissTo: "" };

const rule = (field: string, operator: Operator, value: string, value2?: string): FilterRule => ({ id: makeId(), kind: "rule", field, operator, value, ...(value2 !== undefined ? { value2 } : {}) });
const group = (combinator: "AND" | "OR", children: FilterNode[]): FilterGroupNode => ({ id: makeId(), kind: "group", combinator, children });

function dateRule(field: string, from: string, to: string): FilterRule | null {
  if (from && to) return rule(field, "dateBetween", from, to);
  if (from) return rule(field, "after", shiftDay(from, -1));
  if (to) return rule(field, "before", shiftDay(to, 1));
  return null;
}
// "after"/"before" are exclusive, the form's From/To are inclusive.
function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sicTokens(sic: string): string[] {
  return sic.split(/[\s,;]+/).filter(Boolean);
}

export function validateForm(f: AdvancedForm): string[] {
  const errors: string[] = [];
  for (const [label, from, to] of [
    ["Incorporation date", f.incFrom, f.incTo],
    ["Dissolved date", f.dissFrom, f.dissTo],
  ] as const) {
    for (const v of [from, to]) if (v && !isRealIsoDate(v)) errors.push(`${label}: "${v}" is not a real date.`);
    if (from && to && isRealIsoDate(from) && isRealIsoDate(to) && from > to) errors.push(`${label}: "from" must not be after "to".`);
  }
  const tokens = sicTokens(f.sic);
  if (tokens.some((t) => !/^\d{2,5}$/.test(t))) errors.push("SIC codes must be 2 to 5 digits, for example 68100 or 68.");
  if (tokens.length > 10) errors.push("Use at most 10 SIC codes.");
  if (f.name.length > 200 || f.address.length > 200) errors.push("Text fields are limited to 200 characters.");
  return errors;
}

export function formToFilter(f: AdvancedForm): FilterGroupNode {
  const out = emptyFilterGroup();
  const kids: FilterNode[] = [];
  const name = f.name.trim();
  if (name) kids.push(rule("name", "contains", name));
  const address = f.address.trim();
  if (address) {
    kids.push(group("OR", ["registeredAddress1", "registeredAddress2", "registeredCity", "registeredCounty"].map((k) => rule(k, "contains", address))));
  }
  const postcode = f.postcode.trim();
  if (postcode) kids.push(rule("registeredPostcode", "startsWith", postcode));
  const inc = dateRule("incorporationDate", f.incFrom, f.incTo);
  if (inc) kids.push(inc);
  const anyOf = (field: string, values: string[]): FilterNode | null =>
    values.length === 0 ? null : values.length === 1 ? rule(field, "equals", values[0]) : group("OR", values.map((v) => rule(field, "equals", v)));
  const st = anyOf("status", f.statuses);
  if (st) kids.push(st);
  const sics = sicTokens(f.sic);
  if (sics.length === 1) kids.push(rule("sicCodes", "contains", sics[0]));
  else if (sics.length > 1) kids.push(group("OR", sics.map((c) => rule("sicCodes", "contains", c))));
  const ty = anyOf("type", f.types);
  if (ty) kids.push(ty);
  const diss = dateRule("dissolutionDate", f.dissFrom, f.dissTo);
  if (diss) kids.push(diss);
  out.children = kids;
  return out;
}

// URL <-> form, so the active search survives paging, reloads and sharing the link.
export function formToParams(f: AdvancedForm): URLSearchParams {
  const p = new URLSearchParams();
  const set = (k: string, v: string) => v && p.set(k, v);
  set("name", f.name.trim());
  set("address", f.address.trim());
  set("postcode", f.postcode.trim());
  set("incFrom", f.incFrom);
  set("incTo", f.incTo);
  set("sic", f.sic.trim());
  set("dissFrom", f.dissFrom);
  set("dissTo", f.dissTo);
  if (f.statuses.length) p.set("status", f.statuses.join(","));
  if (f.types.length) p.set("type", f.types.join(","));
  return p;
}

type RawParams = Record<string, string | string[] | undefined>;
export function paramsToForm(raw: RawParams): AdvancedForm {
  const one = (k: string) => {
    const v = raw[k];
    return (Array.isArray(v) ? v[0] : v)?.slice(0, 200) ?? "";
  };
  const list = (k: string, allowed: string[]) => one(k).split(",").filter((v) => allowed.includes(v));
  return {
    name: one("name"),
    address: one("address"),
    postcode: one("postcode"),
    incFrom: one("incFrom"),
    incTo: one("incTo"),
    statuses: list("status", COMPANY_STATUS_OPTIONS.map((o) => o.value)),
    sic: one("sic"),
    types: list("type", COMPANY_TYPE_OPTIONS.map((o) => o.value)),
    dissFrom: one("dissFrom"),
    dissTo: one("dissTo"),
  };
}

export function hasCriteria(f: AdvancedForm): boolean {
  return formToParams(f).size > 0;
}
