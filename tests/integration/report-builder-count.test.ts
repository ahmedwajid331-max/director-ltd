import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, db, group, makeCompany, rule, sessionFor } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// The Report Builder's "Matching companies" figure is /api/companies/search `total` (pageSize 1).
// It must be exact, evaluate nested AND/OR, report zero as 0, and equal saved-report and export results.
test("Report Builder matching count is exact for simple, AND, OR, nested and zero-result filters", async () => {
  const s = await sessionFor("USER");
  const tag = `RB${Date.now() % 1000000}`;
  // 2 dormant+active, 1 dormant+dissolved, 3 not-dormant+active, 1 not-dormant+dissolved
  await makeCompany({ name: `${tag} a1`, status: "active", dormant: true });
  await makeCompany({ name: `${tag} a2`, status: "active", dormant: true });
  await makeCompany({ name: `${tag} b1`, status: "dissolved", dormant: true });
  await makeCompany({ name: `${tag} c1`, status: "active", dormant: false });
  await makeCompany({ name: `${tag} c2`, status: "active", dormant: false });
  await makeCompany({ name: `${tag} c3`, status: "active", dormant: false });
  await makeCompany({ name: `${tag} d1`, status: "dissolved", dormant: false });

  const count = async (filter: unknown) => {
    const r = await api(s, "/api/companies/search", { body: { filter, page: 1, pageSize: 1 } });
    assert.equal(r.status, 200, r.text);
    return r.json.total as number;
  };
  const inTag = rule("name", "startsWith", tag);
  const dormant = rule("dormant", "isTrue");
  const active = rule("status", "equals", "active");
  const dissolved = rule("status", "equals", "dissolved");

  assert.equal(await count(group("AND", inTag)), 7, "simple");
  assert.equal(await count(group("AND", inTag, dormant)), 3, "dormant");
  assert.equal(await count(group("AND", inTag, dormant, active)), 2, "dormant AND active");
  // ALL -> ANY changes the number: (dormant OR active) within tag = 2+1+3 = 6
  assert.equal(await count(group("AND", inTag, group("OR", dormant, active))), 6, "dormant OR active (nested under tag)");
  // Nested: tag AND ((dormant AND active) OR (NOT-dormant AND dissolved)) = 2 + 1
  assert.equal(await count(group("AND", inTag, group("OR", group("AND", dormant, active), group("AND", rule("dormant", "isFalse"), dissolved)))), 3, "nested");
  assert.equal(await count(group("AND", inTag, rule("name", "startsWith", `${tag}-nothing`))), 0, "zero results is 0, not an error");

  // Consistency: the count equals the real row total, a saved report's resultCount, and the CSV row count.
  const f = group("AND", inTag, dormant, active);
  const full = await api(s, "/api/companies/search", { body: { filter: f, page: 1, pageSize: 100 } });
  assert.equal(full.json.rows.length, 2);
  assert.equal(full.json.total, 2);
  const rep = await api(s, "/api/reports", { body: { name: `rb ${tag}`, filter: f, dailyRefresh: false } });
  assert.equal(rep.status, 200, rep.text);
  assert.equal(rep.json.report.resultCount, 2);
});
