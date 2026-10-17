import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_FORM, formToFilter, formToParams, hasCriteria, paramsToForm, validateForm } from "../../src/lib/filters/advancedSearch";
import { compileFilterToWhere } from "../../src/lib/filters/compile";
import { parseFilter } from "../../src/lib/filters/validate";

const base = EMPTY_FORM;

test("an empty form is no criteria and compiles to match-everything", () => {
  assert.equal(hasCriteria(base), false);
  assert.deepEqual(compileFilterToWhere(formToFilter(base)), {});
});

test("every form field produces a filter the validator accepts", () => {
  const form = {
    name: "property",
    address: "london",
    postcode: "sw1a",
    incFrom: "2019-01-01",
    incTo: "2019-12-31",
    statuses: ["liquidation", "active"],
    sic: "68100, 68209",
    types: ["ltd"],
    dissFrom: "2020-01-01",
    dissTo: "2021-01-01",
  };
  assert.deepEqual(validateForm(form), []);
  const filter = formToFilter(form);
  const checked = parseFilter(filter);
  assert.ok(checked.ok, JSON.stringify(checked));
  const where = JSON.stringify(compileFilterToWhere(filter));
  for (const needle of ["registeredAddress1", "registeredCity", "SW1A", "incorporationDate", "liquidation", "68209", "dissolutionDate"]) assert.ok(where.includes(needle), `${needle} missing`);
});

test("one-sided date ranges are inclusive", () => {
  const from = JSON.stringify(compileFilterToWhere(formToFilter({ ...base, incFrom: "2019-03-01" })));
  assert.ok(from.includes("2019-02-28"), from); // "after 28 Feb" = on or after 1 Mar
  const to = JSON.stringify(compileFilterToWhere(formToFilter({ ...base, dissTo: "2021-01-01" })));
  assert.ok(to.includes("2021-01-02"), to); // "before 2 Jan" = on or before 1 Jan
});

test("bad input is rejected with readable messages", () => {
  assert.ok(validateForm({ ...base, incFrom: "2020-02-31" }).length > 0);
  assert.ok(validateForm({ ...base, dissFrom: "2021-01-01", dissTo: "2020-01-01" }).length > 0);
  assert.ok(validateForm({ ...base, sic: "68100; DROP" }).length > 0);
  assert.deepEqual(validateForm({ ...base, sic: "68" }), []);
});

test("the search round-trips through the URL and ignores unknown status/type values", () => {
  const form = { ...base, name: "abc", statuses: ["active", "dissolved"], types: ["plc"], sic: "62012", incFrom: "2020-01-01" };
  const back = paramsToForm(Object.fromEntries(formToParams(form)));
  assert.deepEqual(back, form);
  const junk = paramsToForm({ status: "active,not-a-status", type: "zzz" });
  assert.deepEqual(junk.statuses, ["active"]);
  assert.deepEqual(junk.types, []);
});
