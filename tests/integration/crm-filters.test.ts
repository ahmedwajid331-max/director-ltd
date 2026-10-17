import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

const setState = (s: Session, companyId: string, patch: Record<string, boolean>) => api(s, `/api/companies/${companyId}/state`, { body: patch });
const names = (r: { json: { rows: { name: string }[] } }) => r.json.rows.map((x) => x.name).sort();

// Six companies per tag. User A: saved {0,1,2}, followed {2,3}, red-flagged {4}. User B: saved {5} only.
async function fixture() {
  const tag = `CF${Date.now() % 10000000}`;
  const a = await sessionFor("USER", "crma");
  const b = await sessionFor("USER", "crmb");
  const cs = [];
  for (let i = 0; i < 6; i++) cs.push(await makeCompany({ name: `${tag} C${i}`, status: i === 1 || i === 4 ? "dissolved" : "active" }));
  for (const i of [0, 1, 2]) assert.equal((await setState(a, cs[i].id, { saved: true })).status, 200);
  for (const i of [2, 3]) assert.equal((await setState(a, cs[i].id, { followed: true })).status, 200);
  assert.equal((await setState(a, cs[4].id, { redFlagged: true })).status, 200);
  assert.equal((await setState(b, cs[5].id, { saved: true })).status, 200);
  const search = (s: Session, rules: unknown[], extra: Record<string, unknown> = {}, combinator: "AND" | "OR" = "AND") =>
    api(s, "/api/companies/search", { body: { page: 1, pageSize: 100, filter: group("AND", rule("name", "startsWith", tag), group(combinator, ...rules)), ...extra } });
  return { tag, a, b, cs, search };
}

test("Saved / Followed / Red flagged filters return only the signed-in user's own state", async () => {
  const { tag, a, b, search } = await fixture();
  assert.deepEqual(names(await search(a, [rule("saved", "isTrue")])), [`${tag} C0`, `${tag} C1`, `${tag} C2`]);
  assert.deepEqual(names(await search(a, [rule("followed", "isTrue")])), [`${tag} C2`, `${tag} C3`]);
  assert.deepEqual(names(await search(a, [rule("redFlagged", "isTrue")])), [`${tag} C4`]);
  // User B sees none of A's state, only their own.
  assert.deepEqual(names(await search(b, [rule("saved", "isTrue")])), [`${tag} C5`]);
  assert.deepEqual(names(await search(b, [rule("followed", "isTrue")])), []);
  // "No" is the complement within the user's own state.
  assert.equal((await search(a, [rule("saved", "isFalse")])).json.total, 3);
});

test("CRM filters combine with AND, OR and nested groups", async () => {
  const { tag, a, search } = await fixture();
  assert.deepEqual(names(await search(a, [rule("status", "equals", "active"), rule("saved", "isTrue")])), [`${tag} C0`, `${tag} C2`]);
  assert.deepEqual(names(await search(a, [rule("followed", "isTrue"), rule("redFlagged", "isTrue")], {}, "OR")), [`${tag} C2`, `${tag} C3`, `${tag} C4`]);
  const nested = await api(a, "/api/companies/search", {
    body: {
      page: 1,
      pageSize: 100,
      filter: group("AND", rule("name", "startsWith", tag), group("OR", group("AND", rule("status", "equals", "active"), rule("saved", "isTrue")), rule("redFlagged", "isTrue"))),
    },
  });
  assert.deepEqual(names(nested), [`${tag} C0`, `${tag} C2`, `${tag} C4`]);
});

test("CRM filters work with pagination and sorting", async () => {
  const { tag, a, search } = await fixture();
  const seen: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await search(a, [rule("saved", "isTrue")], { page, pageSize: 1, sortField: "name", sortDir: "desc" });
    assert.equal(r.json.total, 3);
    assert.equal(r.json.pageCount, 3);
    seen.push(...r.json.rows.map((x: { name: string }) => x.name));
  }
  assert.deepEqual(seen, [`${tag} C2`, `${tag} C1`, `${tag} C0`]);
});

test("CSV export honours CRM filters", async () => {
  const { tag, a, b } = await fixture();
  const filter = group("AND", rule("name", "startsWith", tag), rule("saved", "isTrue"));
  const exp = await api(a, "/api/companies/export", { body: { filter } });
  assert.equal(exp.status, 200, exp.text.slice(0, 200));
  for (const i of [0, 1, 2]) assert.match(exp.text, new RegExp(`${tag} C${i}`));
  for (const i of [3, 4, 5]) assert.doesNotMatch(exp.text, new RegExp(`${tag} C${i}`));
  const expB = await api(b, "/api/companies/export", { body: { filter } });
  assert.match(expB.text, new RegExp(`${tag} C5`));
  assert.doesNotMatch(expB.text, new RegExp(`${tag} C0`));
});

test("saved reports with CRM filters count, view and refresh against the owner's own state", async () => {
  const { tag, a, b, cs } = await fixture();
  const filter = group("AND", rule("name", "startsWith", tag), rule("saved", "isTrue"));
  const created = await api(a, "/api/reports", { body: { name: `crm ${tag}`, filter, dailyRefresh: true } });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.report.resultCount, 3);
  const id = created.json.report.id as string;

  const view = await api(a, `/api/reports/${id}`);
  assert.equal(view.status, 200);
  assert.deepEqual(names(view), [`${tag} C0`, `${tag} C1`, `${tag} C2`]);

  // The owner saves one more company; a manual refresh recounts against the OWNER's state.
  await setState(a, cs[3].id, { saved: true });
  const refreshed = await api(a, `/api/reports/${id}/refresh`, { method: "POST", body: {} });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(refreshed.json.report.resultCount, 4);

  // Another user's saves never change the owner's report.
  await setState(b, cs[0].id, { saved: true });
  await setState(b, cs[4].id, { saved: true });
  const again = await api(a, `/api/reports/${id}/refresh`, { method: "POST", body: {} });
  assert.equal(again.json.report.resultCount, 4);
});
