import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyFilterGroup } from "../../src/lib/filters/types";
import { getBool, getChecked, getRange, getText, setBool, setChecked, setRange, setText, clearFields, isActive } from "../../src/lib/filters/criteria";
import { parseFilter } from "../../src/lib/filters/validate";
import { compileFilterToWhere } from "../../src/lib/filters/compile";
import { describeFilter } from "../../src/lib/filters/describe";

const valid = (f: unknown) => assert.equal(parseFilter(f).ok, true, JSON.stringify(parseFilter(f)));

test("ticking several statuses builds an OR group the real compiler accepts; one status is a plain rule", () => {
  let f = setChecked(emptyFilterGroup(), "status", ["active"]);
  assert.equal(f.children[0].kind, "rule");
  f = setChecked(f, "status", ["active", "dissolved"]);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].kind, "group");
  assert.deepEqual(getChecked(f, "status"), ["active", "dissolved"]);
  valid(f);
  assert.ok(compileFilterToWhere(f));
  assert.equal(describeFilter(f), "(Status is Active OR Status is Dissolved)");
  f = setChecked(f, "status", []);
  assert.equal(f.children.length, 0);
});

test("date and number ranges map to the existing operators", () => {
  let f = setRange(emptyFilterGroup(), "incorporationDate", "2020-01-01", "");
  assert.deepEqual(f.children[0], { ...f.children[0], operator: "after", value: "2020-01-01" });
  f = setRange(f, "incorporationDate", "2020-01-01", "2021-01-01");
  assert.equal((f.children[0] as { operator: string }).operator, "dateBetween");
  assert.deepEqual(getRange(f, "incorporationDate"), { from: "2020-01-01", to: "2021-01-01", custom: false });
  f = setRange(f, "directorCount", "", "3");
  assert.equal((f.children[1] as { operator: string }).operator, "lte");
  f = setRange(f, "directorCount", "1", "3");
  assert.equal((f.children[1] as { operator: string }).operator, "between");
  valid(f);
  assert.ok(compileFilterToWhere(f));
  f = setRange(f, "incorporationDate", "", "");
  assert.equal(f.children.length, 1);
});

test("a saved rule the panel cannot express is reported as custom and left untouched", () => {
  const f = { ...emptyFilterGroup(), children: [{ id: "x", kind: "rule" as const, field: "companyAgeYears", operator: "gt" as const, value: 5 }] };
  assert.equal(getRange(f, "companyAgeYears").custom, true);
  assert.equal(f.children.length, 1);
});

test("boolean ticks, text rules and clearing a section", () => {
  let f = setBool(emptyFilterGroup(), "hasDS01", "yes");
  assert.equal(getBool(f, "hasDS01"), "yes");
  f = setBool(f, "hasDS01", "no");
  assert.equal(getBool(f, "hasDS01"), "no");
  assert.equal(describeFilter(f), "DS01 filed (strike-off): No");
  f = setText(f, "registeredPostcode", "startsWith", "SW1A");
  assert.deepEqual(getText(f, "registeredPostcode"), { operator: "startsWith", value: "SW1A" });
  valid(f);
  assert.equal(isActive(f, "registeredPostcode"), true);
  f = clearFields(f, ["hasDS01", "registeredPostcode"]);
  assert.equal(f.children.length, 0);
});
