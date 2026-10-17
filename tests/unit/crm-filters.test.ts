import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFilterToWhere } from "../../src/lib/filters/compile";
import { COMPANY_FILTER_FIELDS } from "../../src/lib/filters/fields";
import { describeFilter } from "../../src/lib/filters/describe";
import { parseFilter } from "../../src/lib/filters/validate";

const rule = (field: string, operator: string, value?: unknown) => ({ id: `r-${field}-${operator}`, kind: "rule", field, operator, ...(value !== undefined ? { value } : {}) });
const group = (combinator: string, ...children: unknown[]) => ({ id: "g", kind: "group", combinator, children });
const now = new Date();

test("CRM fields are registered under My CRM as yes/no filters", () => {
  for (const key of ["followed", "saved", "redFlagged"]) {
    const f = COMPANY_FILTER_FIELDS.find((x) => x.key === key);
    assert.ok(f, key);
    assert.equal(f.group, "My CRM");
    assert.equal(f.type, "boolean");
    assert.deepEqual(f.operators, ["isTrue", "isFalse"]);
    assert.equal(parseFilter(group("AND", rule(key, "isTrue"))).ok, true);
    assert.equal(parseFilter(group("AND", rule(key, "contains", "x"))).ok, false, "no free-text operator on a CRM flag");
  }
  assert.equal(describeFilter(group("AND", rule("saved", "isTrue"), rule("followed", "isFalse")) as never), "Saved: Yes AND Followed: No");
});

test("Saved / Followed / Red flagged compile to an indexed relation filter on THAT user's state row only", () => {
  assert.deepEqual(compileFilterToWhere(group("AND", rule("saved", "isTrue")), now, "confirmed", "u1"), { userStates: { some: { userId: "u1", saved: true } } });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("followed", "isTrue")), now, "confirmed", "u1"), { userStates: { some: { userId: "u1", followed: true } } });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("redFlagged", "isTrue")), now, "confirmed", "u2"), { userStates: { some: { userId: "u2", redFlagged: true } } });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("saved", "isFalse")), now, "confirmed", "u1"), { NOT: { userStates: { some: { userId: "u1", saved: true } } } });
});

test("CRM rules combine with other rules through AND, OR and nested groups", () => {
  const and = compileFilterToWhere(group("AND", rule("status", "equals", "active"), rule("saved", "isTrue")), now, "confirmed", "u1");
  assert.deepEqual(and, { AND: [{ status: "active" }, { userStates: { some: { userId: "u1", saved: true } } }] });
  const or = compileFilterToWhere(group("OR", rule("followed", "isTrue"), rule("redFlagged", "isTrue")), now, "confirmed", "u1");
  assert.deepEqual(or, { OR: [{ userStates: { some: { userId: "u1", followed: true } } }, { userStates: { some: { userId: "u1", redFlagged: true } } }] });
  const nested = compileFilterToWhere(group("OR", group("AND", rule("status", "equals", "active"), rule("saved", "isTrue")), rule("redFlagged", "isTrue")), now, "confirmed", "u1");
  assert.deepEqual(nested, {
    OR: [{ AND: [{ status: "active" }, { userStates: { some: { userId: "u1", saved: true } } }] }, { userStates: { some: { userId: "u1", redFlagged: true } } }],
  });
});

test("director rules are unaffected by CRM rules in the same tree (possible mode)", () => {
  const w = compileFilterToWhere(group("AND", rule("directorCount", "equals", 1), rule("saved", "isTrue")), now, "possible", "u1") as { AND: unknown[] };
  assert.equal(w.AND.length, 2);
  assert.deepEqual(w.AND[0], { OR: [{ officersCoverage: { not: "full" } }, { AND: [{ officersCoverage: "full" }, { directorCount: 1 }] }] });
  assert.deepEqual(w.AND[1], { userStates: { some: { userId: "u1", saved: true } } });
});

test("with no user there is no CRM state: Yes matches nothing, No matches everything", () => {
  assert.deepEqual(compileFilterToWhere(group("AND", rule("saved", "isTrue")), now, "confirmed"), { id: "__no-user__" });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("saved", "isFalse")), now, "confirmed"), {});
});
