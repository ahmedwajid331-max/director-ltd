import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIELD_CATALOGUE, FIELD_CATEGORIES, UNAVAILABLE_FIELDS, defaultEnabled, isSelectable } from "../../src/lib/columns/catalogue";
import { BUILTIN_DEFAULT, PHASE1_COLUMNS, LOCKED_FIRST, MAX_COLUMNS, effectiveColumns, enabledKeys, parseColumnsJson, recommendedChanged, validateColumnList } from "../../src/lib/columns/resolve";
import { dormantState, ds01DateState, overdueState, postcodeArea, prettySlug, sicList } from "../../src/lib/columns/cellRules";
import { SORTABLE_FIELDS } from "../../src/lib/data/companies";
import { COMPANY_FILTER_FIELDS } from "../../src/lib/filters/fields";

const none = new Map<string, boolean>();

// ---- catalogue integrity ----------------------------------------------------------------------------------------

test("the catalogue has the 103 identified options, with unique keys and every category used", () => {
  assert.equal(FIELD_CATALOGUE.length, 103);
  assert.equal(new Set(FIELD_CATALOGUE.map((f) => f.key)).size, 103);
  const perCategory = Object.fromEntries(FIELD_CATEGORIES.map((c) => [c, FIELD_CATALOGUE.filter((f) => f.category === c).length]));
  assert.deepEqual(perCategory, {
    Identity: 18,
    Address: 14,
    Classification: 4,
    "Filing & compliance": 18,
    Officers: 18,
    "Ownership (PSC)": 9,
    "Charges, insolvency & other": 10,
    "Data provenance": 4,
    "My CRM": 8,
  });
  for (const f of FIELD_CATALOGUE) {
    assert.ok(f.label && f.description && f.source, `${f.key} needs a label, description and source`);
  }
  assert.equal(UNAVAILABLE_FIELDS.length, 3);
});

test("only fields whose data is already in the table row are selectable (41), and the rest say why not", () => {
  const selectable = FIELD_CATALOGUE.filter((f) => f.selectable);
  assert.equal(selectable.length, 41);
  for (const f of FIELD_CATALOGUE.filter((x) => !x.selectable && x.availability !== "internal")) {
    assert.ok(f.needs, `${f.key} is not selectable, so it must explain what is needed`);
  }
  // Data that is not collected can never be presented as available.
  for (const f of FIELD_CATALOGUE) {
    if (["import", "rest", "endpoint", "stream"].includes(f.availability)) assert.equal(f.selectable, false, `${f.key} needs data we do not hold`);
  }
});

test("internal fields and personal-data fields can never be switched on", () => {
  const internal = FIELD_CATALOGUE.filter((f) => f.availability === "internal").map((f) => f.key).sort();
  assert.deepEqual(internal, ["createdAt", "officersDirtyAt", "updatedAt"]);
  const restricted = FIELD_CATALOGUE.filter((f) => f.restricted);
  assert.ok(restricted.length >= 8);
  for (const f of [...internal.map((k) => FIELD_CATALOGUE.find((x) => x.key === k)!), ...restricted]) {
    assert.equal(isSelectable(f.key), false, f.key);
    assert.equal(defaultEnabled(f.key), false, f.key);
  }
});

test("sorts and filters claimed in the catalogue are real, existing server-side operations", () => {
  const sortKeys = FIELD_CATALOGUE.filter((f) => f.sortKey).map((f) => f.sortKey!);
  for (const k of sortKeys) assert.ok((SORTABLE_FIELDS as readonly string[]).includes(k), `${k} is not a real server-side sort`);
  // Real server sorts (the original nine plus every stored scalar column); Company age is the mirror of Incorporated.
  // Per-user flags (Followed, Saved, Red flagged, In Trash) and derived display columns are intentionally not sortable.
  const notSortable = ["followed", "saved", "redFlagged", "trashed", "chLink", "postcodeArea", "fullAddress", "sicFirst", "sicCount"];
  for (const k of notSortable) assert.equal(FIELD_CATALOGUE.find((f) => f.key === k)?.sortKey, undefined, `${k} must not claim a sort`);
  assert.equal(new Set(sortKeys).size, SORTABLE_FIELDS.length);
  assert.deepEqual(FIELD_CATALOGUE.filter((f) => f.sortKey === "incorporationDate").map((f) => f.key).sort(), ["companyAgeYears", "incorporationDate"]);
  // Every claimed filter is in the filter registry; the registry has 20 original fields plus 3 date filters.
  const filterKeys = FIELD_CATALOGUE.filter((f) => f.filterKey).map((f) => f.filterKey!);
  const registry = new Set(COMPANY_FILTER_FIELDS.map((f) => f.key));
  for (const k of filterKeys) assert.ok(registry.has(k), `${k} is not in the filter registry`);
  assert.equal(filterKeys.length, 23);
  assert.equal(new Set(filterKeys).size, 23);
  // 23 column-linked filters, plus "Company name starts with letter" (the A-Z bar as a filter) which has no column.
  // ...plus dissolved date and the two address lines, added for Advanced Company Search (no column link).
  assert.equal(COMPANY_FILTER_FIELDS.length, 27);
  assert.ok(registry.has("nameLetter"));
  for (const k of ["accountsLastMadeUp", "confirmationNextDue", "confirmationLastMadeUp"]) {
    const def = COMPANY_FILTER_FIELDS.find((f) => f.key === k)!;
    assert.equal(def.type, "date");
    assert.deepEqual(def.operators, ["before", "after", "dateBetween"]);
  }
});

test("every selectable field has a cell renderer, and the default nine are today's columns", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/components/companies/columnDefs.tsx"), "utf8");
  const block = src.slice(src.indexOf("export const COLUMN_RENDERERS"));
  const rendered = new Set([...block.matchAll(/^  ([A-Za-z0-9]+): \{/gm)].map((m) => m[1]));
  for (const f of FIELD_CATALOGUE.filter((x) => x.selectable && x.key !== "name")) assert.ok(rendered.has(f.key), `${f.key} has no renderer`);
  assert.deepEqual(BUILTIN_DEFAULT, ["name", "companyNumber", "status", "type", "incorporationDate", "registeredCity", "registeredPostcode", "directorCount", "filingSummary"]);
  for (const k of BUILTIN_DEFAULT) assert.ok(isSelectable(k), k);
});

// ---- switches, validation, effective columns ----------------------------------------------------------------------

test("enabledKeys: catalogue defaults, administrator overrides, Company always on", () => {
  const base = enabledKeys(none);
  assert.ok(base.has("name") && base.has("registeredCounty") && base.has("accountsOverdue"));
  assert.ok(!base.has("dissolutionDate"), "empty-by-nature field starts off");
  assert.ok(!base.has("previousNames") && !base.has("officerBirth") && !base.has("createdAt"));
  const changed = enabledKeys(new Map([["registeredCounty", false], ["dissolutionDate", true], ["name", false], ["previousNames", true]]));
  assert.ok(!changed.has("registeredCounty"));
  assert.ok(changed.has("dissolutionDate"));
  assert.ok(changed.has("name"), "Company cannot be switched off");
  assert.ok(!changed.has("previousNames"), "a field without data cannot be switched on");
});

test("validateColumnList accepts a good list and rejects every bad one", () => {
  const enabled = enabledKeys(none);
  assert.deepEqual(validateColumnList(["name", "companyNumber", "registeredCounty"], enabled), { ok: true, columns: ["name", "companyNumber", "registeredCounty"] });
  const bad = (input: unknown, re: RegExp) => {
    const r = validateColumnList(input, enabled);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  };
  bad("name", /list/);
  bad([], /at least one/i);
  bad(["companyNumber", "name"], /first/i);
  bad(["name", "name"], /once/i);
  bad(["name", "nope"], /not an available/);
  bad(["name", "previousNames"], /not an available/);
  bad(["name", "officerBirth"], /not an available/);
  bad(["name", "createdAt"], /not an available/);
  bad(["name", ...Array.from({ length: MAX_COLUMNS }, (_, i) => `k${i}`)], /at most/i);
  const off = enabledKeys(new Map([["registeredCounty", false]]));
  const r = validateColumnList(["name", "registeredCounty"], off);
  assert.equal(r.ok, false);
});

test("effectiveColumns skips switched-off fields without discarding the saved list, and always puts Company first", () => {
  const saved = ["name", "registeredCounty", "companyNumber", "status"];
  const off = enabledKeys(new Map([["registeredCounty", false]]));
  assert.deepEqual(effectiveColumns(saved, off), ["name", "companyNumber", "status"]);
  assert.deepEqual(saved, ["name", "registeredCounty", "companyNumber", "status"], "the saved list is never modified");
  // switched back on: the same saved list shows the column again
  assert.deepEqual(effectiveColumns(saved, enabledKeys(none)), saved);
  assert.deepEqual(effectiveColumns(["status", "type"], enabledKeys(none)), ["name", "status", "type"]);
  assert.deepEqual(effectiveColumns(["name", "status", "status", "unknown-key"], enabledKeys(none)), ["name", "status"]);
});

test("effectiveColumns falls back to the safe default when nothing usable is saved", () => {
  const e = enabledKeys(none);
  assert.deepEqual(effectiveColumns(null, e), BUILTIN_DEFAULT);
  assert.deepEqual(effectiveColumns([], e), BUILTIN_DEFAULT);
  assert.deepEqual(effectiveColumns(["bogus", "alsoBogus"], e), BUILTIN_DEFAULT);
});

test("parseColumnsJson tolerates damaged storage", () => {
  assert.deepEqual(parseColumnsJson('["name","status"]'), ["name", "status"]);
  assert.equal(parseColumnsJson("{"), null);
  assert.equal(parseColumnsJson('{"a":1}'), null);
  assert.equal(parseColumnsJson("[1,2]"), null);
  assert.equal(parseColumnsJson(null), null);
});

test("recommendedChanged: only users with their own saved list are told, and only when the recommendation moved", () => {
  const def = { id: "L1", version: 2 };
  assert.equal(recommendedChanged(null, def), false);
  assert.equal(recommendedChanged({ columns: ["name"], baseLayoutId: "L1", baseLayoutVersion: 2 }, def), false);
  assert.equal(recommendedChanged({ columns: ["name"], baseLayoutId: "L1", baseLayoutVersion: 1 }, def), true);
  assert.equal(recommendedChanged({ columns: ["name"], baseLayoutId: "OLD", baseLayoutVersion: 9 }, def), true);
  assert.equal(recommendedChanged({ columns: ["name"], baseLayoutId: null, baseLayoutVersion: null }, def), true);
});

// ---- cell wording ----------------------------------------------------------------------------------------------

test("overdue is never a false No: not applicable for inactive companies, unknown without a due date", () => {
  assert.equal(overdueState("dissolved", false, "2020-01-01"), "not_applicable");
  assert.equal(overdueState("active", true, "2020-01-01"), "yes");
  assert.equal(overdueState("active", false, null), "unknown");
  assert.equal(overdueState("active", false, "2030-01-01"), "no");
  assert.equal(overdueState("liquidation", true, "2020-01-01"), "not_applicable");
});

test("dormant is unknown when no accounts type is recorded", () => {
  assert.equal(dormantState(null, false), "unknown");
  assert.equal(dormantState("", false), "unknown");
  assert.equal(dormantState("micro-entity", false), "no");
  assert.equal(dormantState("dormant", true), "yes");
});

test("DS01 date: not applicable, not recorded, or the date", () => {
  assert.equal(ds01DateState(false, null), "not_applicable");
  assert.equal(ds01DateState(true, null), "not_recorded");
  assert.equal(ds01DateState(true, "2026-01-01"), "date");
});

test("small text helpers", () => {
  assert.equal(prettySlug("total-exemption-full"), "Total exemption full");
  assert.equal(prettySlug("bulk_import"), "Bulk import");
  assert.equal(prettySlug(null), "");
  assert.equal(postcodeArea("SW1A 1AA"), "SW1A");
  assert.equal(postcodeArea(""), "");
  assert.deepEqual(sicList("62012,70229"), ["62012", "70229"]);
  assert.deepEqual(sicList(""), []);
  assert.equal(LOCKED_FIRST, "name");
});

// ---- the 33 Phase 1 columns --------------------------------------------------------------------------------------

test("the 33 Phase 1 columns: today's nine first, then the 24 proposed, all unique, selectable and drawable", () => {
  assert.equal(PHASE1_COLUMNS.length, 33);
  assert.equal(new Set(PHASE1_COLUMNS).size, 33);
  assert.deepEqual(PHASE1_COLUMNS.slice(0, 9), BUILTIN_DEFAULT);
  assert.equal(PHASE1_COLUMNS[0], LOCKED_FIRST);
  const proposedExtra = [
    "companyAgeYears", "statusDetail", "source", "registeredAddress1", "registeredAddress2", "registeredCounty", "sicCodes", "accountsNextDue", "accountsLastMadeUp",
    "accountsOverdue", "confirmationNextDue", "confirmationLastMadeUp", "confirmationOverdue", "dormant", "accountType", "hasDS01", "ds01FiledAt", "officersCoverage",
    "officersFetchedAt", "singleDirector", "chLastFetchedAt", "followed", "saved", "redFlagged",
  ];
  assert.deepEqual([...PHASE1_COLUMNS.slice(9)].sort(), [...proposedExtra].sort());
  const src = fs.readFileSync(path.join(__dirname, "../../src/components/companies/columnDefs.tsx"), "utf8");
  const block = src.slice(src.indexOf("export const COLUMN_RENDERERS"));
  for (const k of PHASE1_COLUMNS) {
    assert.ok(isSelectable(k), `${k} must be selectable`);
    if (k !== "name") assert.ok(new RegExp(`^  ${k}: \{`, "m").test(block), `${k} must have a cell renderer`);
  }
  // The whole list is valid to save as a layout or personal preference.
  assert.deepEqual(validateColumnList(PHASE1_COLUMNS, enabledKeys(new Map())), { ok: true, columns: PHASE1_COLUMNS });
  assert.ok(PHASE1_COLUMNS.length <= MAX_COLUMNS);
});

test("only the 33 approved Phase 1 columns are on for users by default", () => {
  assert.deepEqual([...enabledKeys(new Map())].sort(), [...PHASE1_COLUMNS].sort());
  // the other displayable fields stay off unless an administrator switches them on through the API
  for (const k of ["dissolutionDate", "chLink", "postcodeArea", "fullAddress", "sicFirst", "sicCount", "officersUnavailableReason", "trashed"]) {
    assert.ok(isSelectable(k) && !enabledKeys(new Map()).has(k), k);
  }
});
