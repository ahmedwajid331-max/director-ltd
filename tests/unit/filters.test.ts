import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFilterToWhere, utcToday, yearsBefore } from "../../src/lib/filters/compile";
import { FilterValidationError, parseFilter } from "../../src/lib/filters/validate";

const rule = (field: string, operator: string, value?: unknown, value2?: unknown) => ({
  id: "r", kind: "rule", field, operator, ...(value !== undefined ? { value } : {}), ...(value2 !== undefined ? { value2 } : {}),
});
const group = (combinator: string, ...children: unknown[]) => ({ id: "g", kind: "group", combinator, children });

// Director rules are gated on confirmed officer coverage (see compile.ts).
const full = (where: unknown) => ({ AND: [{ officersCoverage: "full" }, where] });

function rejects(input: unknown, re?: RegExp) {
  const res = parseFilter(input);
  assert.equal(res.ok, false, `expected rejection of ${JSON.stringify(input)}`);
  if (!res.ok && re) assert.match(res.errors.join(" | "), re);
  assert.throws(() => compileFilterToWhere(input), FilterValidationError);
}

test("director count: exactly 1, exactly 2 (numeric equals, the old HTTP 500)", () => {
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "equals", 1))), full({ directorCount: 1 }));
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "equals", "2"))), full({ directorCount: 2 })); // UI sends strings
});

test("director count comparisons and range", () => {
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "gt", 2))), full({ directorCount: { gt: 2 } }));
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "gte", 3))), full({ directorCount: { gte: 3 } }));
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "lt", 3))), full({ directorCount: { lt: 3 } }));
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "lte", 4))), full({ directorCount: { lte: 4 } }));
  assert.deepEqual(compileFilterToWhere(group("AND", rule("directorCount", "between", 5, 2))), full({ directorCount: { gte: 2, lte: 5 } }));
});

test("rejects unknown fields and internal fields (id, source, relations, secrets)", () => {
  for (const f of ["id", "source", "directors", "userStates", "passwordHash", "officersCoverage", "__proto__"]) {
    rejects(group("AND", rule(f, "equals", "x")), /unknown filter field/);
  }
});

test("rejects operators that the field does not offer", () => {
  rejects(group("AND", rule("name", "gt", "5")), /not allowed/);
  rejects(group("AND", rule("directorCount", "contains", "1")), /not allowed/);
  rejects(group("AND", rule("status", "notEquals", "active")), /not allowed/);
});

test("rejects NaN, Infinity, negatives, fractions and non-numbers", () => {
  rejects(group("AND", rule("directorCount", "gt", "abc")), /needs a number/);
  rejects(group("AND", rule("directorCount", "gt", NaN)), /needs a number/);
  rejects(group("AND", rule("directorCount", "gt", Infinity)), /needs a number/);
  rejects(group("AND", rule("directorCount", "equals", -1)), /between 0/);
  rejects(group("AND", rule("directorCount", "equals", 1.5)), /whole number/);
  rejects(group("AND", rule("companyAgeYears", "gt", 1e9)), /between 0/);
  rejects(group("AND", rule("directorCount", "between", 1, "x")), /needs a number/);
});

test("rejects malformed and impossible dates", () => {
  rejects(group("AND", rule("incorporationDate", "before", "notadate")), /real date/);
  rejects(group("AND", rule("incorporationDate", "before", "2020-02-30")), /real date/);
  rejects(group("AND", rule("incorporationDate", "after", "01/02/2020")), /real date/);
  rejects(group("AND", rule("accountsNextDue", "dateBetween", "2020-01-01", "nope")), /real date/);
});

test("rejects malformed filter trees", () => {
  rejects({ foo: 1 }, /kind/);
  rejects("a string", /not a valid filter node/);
  rejects([1, 2], /not a valid filter node/);
  rejects(group("XOR"), /combinator/);
  rejects({ id: "g", kind: "group", combinator: "AND", children: "nope" }, /children/);
  rejects(group("AND", 42), /not a valid filter node/);
  let deep: unknown = rule("dormant", "isTrue");
  for (let i = 0; i < 10; i++) deep = group("AND", deep);
  rejects(deep, /nested/);
  rejects(group("AND", ...Array.from({ length: 80 }, () => rule("dormant", "isTrue"))), /more than/);
});

test("rejects bad enum values and oversize strings", () => {
  rejects(group("AND", rule("status", "equals", "not-a-status")), /not a valid/);
  rejects(group("AND", rule("type", "equals", "DROP TABLE;")), /not a valid/);
  rejects(group("AND", rule("name", "contains", "x".repeat(500))), /too long/);
});

test("null / undefined filter means no filter; blank rules are inactive, not errors", () => {
  assert.deepEqual(compileFilterToWhere(null), {});
  assert.deepEqual(compileFilterToWhere(undefined), {});
  assert.deepEqual(compileFilterToWhere(group("AND", rule("name", "contains", ""))), {});
  assert.deepEqual(compileFilterToWhere(group("AND")), {});
});

test("boolean rules: DS01, dormant, single director, late filing", () => {
  assert.deepEqual(compileFilterToWhere(group("AND", rule("hasDS01", "isTrue"))), { hasDS01: true });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("dormant", "isFalse"))), { dormant: false });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("singleDirector", "isTrue"))), full({ singleDirector: true }));
  assert.deepEqual(compileFilterToWhere(group("AND", rule("accountsOverdue", "isTrue"))), { accountsOverdue: true });
});

test("AND / OR / nesting compile to the expected tree", () => {
  const w = compileFilterToWhere(
    group("AND", rule("hasDS01", "isTrue"), group("OR", rule("dormant", "isTrue"), rule("registeredPostcode", "startsWith", "sw")))
  );
  assert.deepEqual(w, {
    AND: [{ hasDS01: true }, { OR: [{ dormant: true }, { registeredPostcode: { startsWith: "SW" } }] }],
  });
});

test("string matching is case-insensitive except upper-cased postcode / company number", () => {
  assert.deepEqual(compileFilterToWhere(group("AND", rule("name", "contains", "Acme"))), { name: { contains: "Acme", mode: "insensitive" } });
  assert.deepEqual(compileFilterToWhere(group("AND", rule("companyNumber", "equals", "sc123456"))), { companyNumber: { equals: "SC123456" } });
});

// ---- company age: calendar-date semantics ------------------------------------
test("age boundaries use the calendar date, not the time of day", () => {
  const now = new Date("2026-09-30T14:29:00Z");
  const today = utcToday(now);
  assert.equal(today.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.equal(yearsBefore(today, 10).toISOString(), "2016-09-30T00:00:00.000Z");

  // "older than 10 years": incorporated strictly before 2016-09-30.
  const gt10 = compileFilterToWhere(group("AND", rule("companyAgeYears", "gt", 10)), now) as { incorporationDate: { lt: Date } };
  assert.equal(gt10.incorporationDate.lt.toISOString(), "2016-09-30T00:00:00.000Z");
  // A company incorporated 2016-09-30 is exactly 10 today -> NOT "> 10", but IS ">= 10".
  const gte10 = compileFilterToWhere(group("AND", rule("companyAgeYears", "gte", 10)), now) as { incorporationDate: { lte: Date } };
  assert.equal(gte10.incorporationDate.lte.toISOString(), "2016-09-30T00:00:00.000Z");
  const between = compileFilterToWhere(group("AND", rule("companyAgeYears", "between", 2, 5)), now) as { incorporationDate: { gte: Date; lte: Date } };
  assert.equal(between.incorporationDate.gte.toISOString(), "2021-09-30T00:00:00.000Z");
  assert.equal(between.incorporationDate.lte.toISOString(), "2024-09-30T00:00:00.000Z");
});

test("leap day minus N years clamps to 28 Feb", () => {
  assert.equal(yearsBefore(new Date("2024-02-29T00:00:00Z"), 1).toISOString(), "2023-02-28T00:00:00.000Z");
  assert.equal(yearsBefore(new Date("2024-02-29T00:00:00Z"), 4).toISOString(), "2020-02-29T00:00:00.000Z");
});

test("director filters only match confirmed (full) officer coverage, for every operator", () => {
  const cases: unknown[][] = [
    ["directorCount", "equals", 0],
    ["directorCount", "lt", 2],
    ["directorCount", "lte", 1],
    ["directorCount", "between", 0, 3],
    ["singleDirector", "isFalse"],
    ["singleDirector", "isTrue"],
  ];
  for (const [field, op, v, v2] of cases) {
    const where = compileFilterToWhere(group("AND", rule(field as string, op as string, v, v2))) as { AND?: unknown[] };
    assert.deepEqual(where.AND?.[0], { officersCoverage: "full" }, `${field} ${op}`);
  }
  // non-director rules are not gated
  assert.deepEqual(compileFilterToWhere(group("AND", rule("dormant", "isFalse"))), { dormant: false });
  // gate survives OR
  const or = compileFilterToWhere(group("OR", rule("directorCount", "equals", 0), rule("hasDS01", "isTrue"))) as { OR: unknown[] };
  assert.deepEqual(or.OR[0], full({ directorCount: 0 }));
});

// ---- three-valued director filters: confirmed vs possible ----------------------------------------------------
import { hasActiveDirectorRules } from "../../src/lib/filters/compile";

test("possible mode: a director rule also admits every company whose officers are not confirmed", () => {
  const f = group("AND", rule("directorCount", "equals", 1));
  assert.deepEqual(compileFilterToWhere(f, new Date(), "confirmed"), full({ directorCount: 1 }));
  assert.deepEqual(compileFilterToWhere(f, new Date(), "possible"), { OR: [{ officersCoverage: { not: "full" } }, full({ directorCount: 1 })] });
  // single director, yes and no
  assert.deepEqual(compileFilterToWhere(group("AND", rule("singleDirector", "isFalse")), new Date(), "possible"), { OR: [{ officersCoverage: { not: "full" } }, full({ singleDirector: false })] });
});

test("possible mode leaves non-director rules untouched, so possible - confirmed is exactly the unevaluable set", () => {
  const f = group("AND", rule("hasDS01", "isTrue"), rule("directorCount", "gt", 2), rule("dormant", "isFalse"));
  const possible = compileFilterToWhere(f, new Date(), "possible") as { AND: unknown[] };
  assert.deepEqual(possible.AND[0], { hasDS01: true });
  assert.deepEqual(possible.AND[1], { OR: [{ officersCoverage: { not: "full" } }, full({ directorCount: { gt: 2 } })] });
  assert.deepEqual(possible.AND[2], { dormant: false });
});

test("possible mode through nested AND / OR groups: each director rule is relaxed, the structure is preserved", () => {
  const f = group("OR", group("AND", rule("status", "equals", "active"), rule("directorCount", "equals", 0)), group("AND", rule("hasDS01", "isTrue"), rule("singleDirector", "isTrue")));
  const where = compileFilterToWhere(f, new Date(), "possible") as { OR: { AND: unknown[] }[] };
  assert.equal(where.OR.length, 2);
  assert.deepEqual(where.OR[0].AND[0], { status: "active" });
  assert.deepEqual(where.OR[0].AND[1], { OR: [{ officersCoverage: { not: "full" } }, full({ directorCount: 0 })] });
  assert.deepEqual(where.OR[1].AND[0], { hasDS01: true });
  assert.deepEqual(where.OR[1].AND[1], { OR: [{ officersCoverage: { not: "full" } }, full({ singleDirector: true })] });
  // the confirmed compilation of the same tree has no relaxation
  const confirmed = compileFilterToWhere(f) as { OR: { AND: unknown[] }[] };
  assert.deepEqual(confirmed.OR[0].AND[1], full({ directorCount: 0 }));
});

test("hasActiveDirectorRules: only an ACTIVE director rule makes an unknown count meaningful", () => {
  assert.equal(hasActiveDirectorRules(group("AND", rule("directorCount", "equals", 1))), true);
  assert.equal(hasActiveDirectorRules(group("AND", rule("singleDirector", "isTrue"))), true);
  assert.equal(hasActiveDirectorRules(group("AND", group("OR", rule("name", "contains", "x"), rule("directorCount", "lt", 3)))), true);
  assert.equal(hasActiveDirectorRules(group("AND", rule("directorCount", "equals", ""))), false, "an empty rule is inactive");
  assert.equal(hasActiveDirectorRules(group("AND", rule("hasDS01", "isTrue"))), false);
  assert.equal(hasActiveDirectorRules(null), false);
});
