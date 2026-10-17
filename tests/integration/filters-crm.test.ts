import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, BASE_PROD, api, db, group, makeCompany, rule, sessionFor } from "./helpers";

after(async () => {
  await db.$disconnect();
});

const search = (s: Awaited<ReturnType<typeof sessionFor>>, body: Record<string, unknown>, base?: string) =>
  api(s, "/api/companies/search", { body: { page: 1, pageSize: 100, ...body }, base });

// ---- Filter validation over HTTP ----------------------------------------------------
test("invalid filters return a controlled 400, never a 500", async () => {
  const s = await sessionFor("USER");
  const bad: [string, unknown][] = [
    ["unknown field", group("AND", rule("passwordHash", "equals", "x"))],
    ["internal field id", group("AND", rule("id", "startsWith", "c"))],
    ["internal field source", group("AND", rule("source", "equals", "seed"))],
    ["relation field", group("AND", rule("directors", "equals", "x"))],
    ["NaN", group("AND", rule("directorCount", "gt", "abc"))],
    ["bad date", group("AND", rule("incorporationDate", "before", "notadate"))],
    ["garbage object", { foo: 1 }],
    ["string", "just a string"],
    ["bad operator", group("AND", rule("name", "gt", "5"))],
  ];
  for (const [name, filter] of bad) {
    const r = await search(s, { filter });
    assert.equal(r.status, 400, `${name} -> ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(r.json.error);
  }
  const rep = await api(s, "/api/reports", { body: { name: "bad", filter: { foo: 1 } } });
  assert.equal(rep.status, 400);
});

test("director count: exactly 1, exactly 2, >, >=, <, <=, between match the database", async () => {
  const s = await sessionFor("USER");
  const tag = `DC${Date.now() % 1000000}`;
  const make = (n: number) => makeCompany({ name: `${tag} ${n}`, directorCount: n, singleDirector: n === 1, officersCoverage: "full" });
  for (const n of [0, 1, 1, 2, 3, 3, 3, 5]) await make(n);
  const f = (r: unknown) => group("AND", rule("name", "startsWith", tag), r);
  const count = async (r: unknown) => (await search(s, { filter: f(r), pageSize: 1 })).json.total as number;
  assert.equal(await count(rule("directorCount", "equals", 1)), 2);
  assert.equal(await count(rule("directorCount", "equals", 2)), 1);
  assert.equal(await count(rule("directorCount", "equals", "3")), 3); // UI sends strings
  assert.equal(await count(rule("directorCount", "gt", 2)), 4);
  assert.equal(await count(rule("directorCount", "gte", 3)), 4);
  assert.equal(await count(rule("directorCount", "lt", 2)), 3);
  assert.equal(await count(rule("directorCount", "lte", 1)), 3);
  assert.equal(await count(rule("directorCount", "between", 2, 3)), 4);
  assert.equal(await count(rule("singleDirector", "isTrue")), 2);
});

test("director filters and CSV export never treat unfetched officer data as zero / not-single", async () => {
  const s = await sessionFor("USER");
  const tag = `NF${Date.now() % 1000000}`;
  const mk = (label: string, over: Record<string, unknown>) => makeCompany({ name: `${tag} ${label}`, ...over });
  await mk("unfetched", { officersCoverage: "none", directorCount: 0, singleDirector: false });
  await mk("partial", { officersCoverage: "partial", directorCount: 0, singleDirector: false });
  await mk("zero", { officersCoverage: "full", directorCount: 0, singleDirector: false });
  await mk("one", { officersCoverage: "full", directorCount: 1, singleDirector: true });
  await mk("three", { officersCoverage: "full", directorCount: 3, singleDirector: false });
  const names = async (r: unknown) =>
    ((await search(s, { filter: group("AND", rule("name", "startsWith", tag), r) })).json.rows as { name: string }[]).map((x) => x.name.slice(tag.length + 1)).sort();
  assert.deepEqual(await names(rule("directorCount", "equals", 0)), ["zero"]);
  assert.deepEqual(await names(rule("directorCount", "lt", 2)), ["one", "zero"]);
  assert.deepEqual(await names(rule("directorCount", "lte", 1)), ["one", "zero"]);
  assert.deepEqual(await names(rule("directorCount", "equals", 1)), ["one"]);
  assert.deepEqual(await names(rule("directorCount", "equals", 3)), ["three"]);
  assert.deepEqual(await names(rule("singleDirector", "isTrue")), ["one"]);
  assert.deepEqual(await names(rule("singleDirector", "isFalse")), ["three", "zero"]);

  const exp = await api(s, "/api/companies/export", { body: { filter: group("AND", rule("name", "startsWith", tag)) } });
  assert.equal(exp.status, 200);
  const line = (label: string) => exp.text.split(/\r?\n/).find((l) => l.includes(`${tag} ${label}`)) ?? "";
  for (const l of ["unfetched", "partial"]) assert.match(line(l), /Not fetched,Not fetched/, l);
  assert.match(line("zero"), /,0,No,/);
  assert.match(line("one"), /,1,Yes,/);
  assert.match(line("three"), /,3,No,/);
});

test("company age uses calendar dates at the boundary", async () => {
  const s = await sessionFor("USER");
  const tag = `AGE${Date.now() % 1000000}`;
  const now = new Date();
  const dayUtc = (yearsAgo: number, dayOffset = 0) => new Date(Date.UTC(now.getUTCFullYear() - yearsAgo, now.getUTCMonth(), now.getUTCDate() + dayOffset));
  await makeCompany({ name: `${tag} exactly10`, incorporationDate: dayUtc(10) });
  await makeCompany({ name: `${tag} just-over10`, incorporationDate: dayUtc(10, -1) });
  await makeCompany({ name: `${tag} just-under10`, incorporationDate: dayUtc(10, 1) });
  const names = async (op: string, n: number) =>
    ((await search(s, { filter: group("AND", rule("name", "startsWith", tag), rule("companyAgeYears", op, n)) })).json.rows as { name: string }[]).map((r) => r.name.split(" ")[1]).sort();
  assert.deepEqual(await names("gt", 10), ["just-over10"]); // exactly 10 is NOT "more than 10"
  assert.deepEqual(await names("gte", 10), ["exactly10", "just-over10"]);
  assert.deepEqual(await names("lt", 10), ["just-under10"]);
  assert.deepEqual(await names("lte", 10), ["exactly10", "just-under10"]);
});

test("string filters are case-insensitive (name) and postcode prefix is normalised", async () => {
  const s = await sessionFor("USER");
  const tag = `CI${Date.now() % 1000000}`;
  await makeCompany({ name: `Acme ${tag} Widgets Ltd`, registeredPostcode: "SW1A 1AA" });
  assert.equal((await search(s, { filter: group("AND", rule("name", "contains", `ACME ${tag.toLowerCase()}`)) })).json.total, 1);
  assert.equal((await search(s, { filter: group("AND", rule("name", "contains", tag), rule("registeredPostcode", "startsWith", "sw1a")) })).json.total, 1);
});

test("sorting is deterministic: ties never repeat or drop rows across pages", async () => {
  const s = await sessionFor("USER");
  const tag = `S${Date.now() % 100000}`;
  await db.company.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      companyNumber: `${tag}${String(i).padStart(2, "0")}`, name: `${tag} SAME NAME`, status: "active", type: "ltd",
      incorporationDate: new Date("2010-01-01T00:00:00Z"), registeredAddress1: "x", registeredCity: "y", registeredPostcode: "SO1 1AA", source: "bulk_import",
    })),
  });
  const filter = group("AND", rule("name", "startsWith", tag));
  for (const sortField of ["name", "status", "directorCount", "accountsNextDue"]) {
    const seen: string[] = [];
    for (let page = 1; page <= 6; page++) {
      const r = await search(s, { filter, page, pageSize: 7, sortField, sortDir: "asc" });
      seen.push(...r.json.rows.map((x: { id: string }) => x.id));
      if (page >= r.json.pageCount) break;
    }
    assert.equal(seen.length, 30, sortField);
    assert.equal(new Set(seen).size, 30, `${sortField}: duplicates across pages`);
  }
});

// ---- CRM ---------------------------------------------------------------------------------
test("unknown company id -> 404 for state, notes, follow-ups and contacts", async () => {
  const s = await sessionFor("USER");
  assert.equal((await api(s, "/api/companies/does-not-exist/state", { body: { followed: true } })).status, 404);
  assert.equal((await api(s, "/api/companies/does-not-exist/notes", { body: { body: "hello" } })).status, 404);
  assert.equal((await api(s, "/api/companies/does-not-exist/followups", { body: { dueDate: "2030-01-15" } })).status, 404);
  assert.equal((await api(s, "/api/companies/does-not-exist/directors", { body: { name: "Nobody" } })).status, 404);
});

test("follow and trash are mutually exclusive, and restore leaves the company un-followed", async () => {
  const s = await sessionFor("USER");
  const c = await makeCompany();
  const state = async () => (await db.userCompanyState.findUnique({ where: { userId_companyId: { userId: s.userId, companyId: c.id } } }))!;
  await api(s, `/api/companies/${c.id}/state`, { body: { followed: true } });
  assert.deepEqual([(await state()).followed, (await state()).trashed], [true, false]);
  await api(s, `/api/companies/${c.id}/state`, { body: { trashed: true } }); // trash a followed company
  assert.deepEqual([(await state()).followed, (await state()).trashed], [false, true]);
  const inTrash = await search(s, { scope: "trashed", filter: group("AND", rule("companyNumber", "equals", c.companyNumber)) });
  assert.equal(inTrash.json.total, 1);
  const inFollowed = await search(s, { scope: "followed", filter: group("AND", rule("companyNumber", "equals", c.companyNumber)) });
  assert.equal(inFollowed.json.total, 0);
  await api(s, `/api/companies/${c.id}/state`, { body: { followed: true } }); // following a trashed company restores it
  assert.deepEqual([(await state()).followed, (await state()).trashed], [true, false]);
  await api(s, `/api/companies/${c.id}/state`, { body: { trashed: true } });
  await api(s, `/api/companies/${c.id}/state`, { body: { trashed: false } }); // restore
  assert.deepEqual([(await state()).followed, (await state()).trashed], [false, false]);
  assert.equal((await api(s, `/api/companies/${c.id}/state`, { body: {} })).status, 400);
});

test("saved and red flag are independent of follow/trash, per user, and set in bulk", async () => {
  const a = await sessionFor("USER");
  const b = await sessionFor("USER");
  const [c1, c2] = [await makeCompany(), await makeCompany()];
  const stateOf = async (userId: string, companyId: string) =>
    (await db.userCompanyState.findUnique({ where: { userId_companyId: { userId, companyId } } }))!;

  const r = await api(a, "/api/companies/bulk-state", { body: { ids: [c1.id, c2.id, "does-not-exist"], patch: { saved: true, redFlagged: true } } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.updated, r.json.skipped], [2, 1]);

  await api(a, "/api/companies/bulk-state", { body: { ids: [c1.id], patch: { followed: true } } });
  await api(a, "/api/companies/bulk-state", { body: { ids: [c1.id], patch: { trashed: true } } });
  const s1 = await stateOf(a.userId, c1.id);
  assert.deepEqual([s1.saved, s1.redFlagged, s1.followed, s1.trashed], [true, true, false, true]); // trash keeps Saved + Red Flag

  const found = await search(a, { scope: "trashed", filter: group("AND", rule("companyNumber", "equals", c1.companyNumber)) });
  assert.deepEqual([found.json.rows[0].saved, found.json.rows[0].redFlagged], [true, true]);

  // Another user's state is untouched and invisible.
  assert.equal(await db.userCompanyState.count({ where: { userId: b.userId, companyId: { in: [c1.id, c2.id] } } }), 0);
  const other = await search(b, { filter: group("AND", rule("companyNumber", "equals", c2.companyNumber)) });
  assert.deepEqual([other.json.rows[0].saved, other.json.rows[0].redFlagged], [false, false]);

  // Validation: auth, empty / oversized id lists, unknown fields, all-unknown ids.
  assert.equal((await api(a, "/api/companies/bulk-state", { body: { ids: [], patch: { saved: true } } })).status, 400);
  assert.equal((await api(a, "/api/companies/bulk-state", { body: { ids: Array(101).fill("x"), patch: { saved: true } } })).status, 400);
  assert.equal((await api(a, "/api/companies/bulk-state", { body: { ids: [c1.id], patch: { userId: "x" } } })).status, 400);
  assert.equal((await api(a, "/api/companies/bulk-state", { body: { ids: ["nope"], patch: { saved: true } } })).status, 404);
  const anon = await fetch(`${BASE}/api/companies/bulk-state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [c1.id], patch: { saved: true } }) });
  assert.equal(anon.status, 401);
});

test("trash is per user: another user still sees the company", async () => {
  const a = await sessionFor("USER");
  const b = await sessionFor("USER");
  const c = await makeCompany();
  await api(a, `/api/companies/${c.id}/state`, { body: { trashed: true } });
  const filter = group("AND", rule("companyNumber", "equals", c.companyNumber));
  assert.equal((await search(a, { filter })).json.total, 0);
  assert.equal((await search(b, { filter })).json.total, 1);
});

test("manual CRM contacts never change directorCount / singleDirector and are private to the user", async () => {
  const a = await sessionFor("USER");
  const b = await sessionFor("USER");
  const c = await makeCompany({ directorCount: 1, singleDirector: true, officersCoverage: "full" }); // "full" so the page does not lazy-fetch from Companies House
  await db.director.create({ data: { companyId: c.id, name: "REAL OFFICER", role: "director", source: "rest" } });

  const r = await api(a, `/api/companies/${c.id}/directors`, { body: { name: "Alice The Buyer", email: "alice@example.com", phone: "0123" } });
  assert.equal(r.status, 200);
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.directorCount, 1);
  assert.equal(after.singleDirector, true);
  assert.equal(await db.director.count({ where: { companyId: c.id } }), 1); // not a Companies House officer
  assert.equal(await db.crmContact.count({ where: { companyId: c.id, userId: a.userId } }), 1);

  // The director filters are unaffected...
  const filter = group("AND", rule("companyNumber", "equals", c.companyNumber), rule("singleDirector", "isTrue"));
  assert.equal((await search(a, { filter })).json.total, 1);

  // ...and the contact only shows on user A's company page.
  const pageA = await fetch(`${BASE}/companies/${c.id}`, { headers: { cookie: `director_session=${a.cookie}` } });
  const pageB = await fetch(`${BASE}/companies/${c.id}`, { headers: { cookie: `director_session=${b.cookie}` } });
  assert.equal(pageA.status, 200);
  assert.match(await pageA.text(), /Alice The Buyer/);
  const htmlB = await pageB.text();
  assert.doesNotMatch(htmlB, /Alice The Buyer/);
  assert.match(htmlB, /REAL OFFICER/);
});

test("follow-up dates are strict date-only values", async () => {
  const s = await sessionFor("USER");
  const c = await makeCompany();
  const ok = await api(s, `/api/companies/${c.id}/followups`, { body: { dueDate: "2030-03-31", note: "x" } });
  assert.equal(ok.status, 200);
  const row = await db.followUp.findFirstOrThrow({ where: { userId: s.userId } });
  assert.equal(row.dueDate.toISOString(), "2030-03-31T00:00:00.000Z");
  for (const bad of ["2030-03-31T10:00:00", "31/03/2030", "2030-02-30", "", "tomorrow"]) {
    assert.equal((await api(s, `/api/companies/${c.id}/followups`, { body: { dueDate: bad } })).status, 400, bad);
  }
  // internal calendar fallback recorded the event
  const ev = await db.calendarEvent.findFirst({ where: { followUpId: row.id } });
  assert.equal(ev?.provider, "INTERNAL");
});

// ---- Seed / real separation ---------------------------------------------------------------
test("seed data is hidden from search, export and reports when SEED_DATA_VISIBLE=false", async () => {
  const dev = await sessionFor("USER", "seedsplit", BASE);
  const prod = await sessionFor("USER", "seedsplit", BASE_PROD);
  const tag = `SEEDSPLIT${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} REAL`, source: "bulk_import" });
  await makeCompany({ name: `${tag} FAKE`, source: "seed" });
  const filter = group("AND", rule("name", "startsWith", tag));

  assert.equal((await search(dev, { filter })).json.total, 2); // development mode: both visible
  const prodResult = await search(prod, { filter }, BASE_PROD);
  assert.equal(prodResult.json.total, 1);
  assert.match(prodResult.json.rows[0].name, /REAL/);

  const exp = await api(prod, "/api/companies/export", { body: { filter }, base: BASE_PROD });
  assert.equal(exp.status, 200);
  assert.doesNotMatch(exp.text, /FAKE/);
  assert.match(exp.text, /REAL/);

  const rep = await api(prod, "/api/reports", { body: { name: "seed split", filter }, base: BASE_PROD });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.report.resultCount, 1);
});

test("the dashboard and landing page report real coverage, not total rows", async () => {
  const prod = await sessionFor("USER", "cov", BASE_PROD);
  await makeCompany({ source: "seed" });
  const dash = await (await fetch(`${BASE_PROD}/dashboard`, { headers: { cookie: `director_session=${prod.cookie}` } })).text();
  assert.match(dash, /Companies House register/);
  assert.match(dash, /companies loaded/);
  assert.doesNotMatch(dash, /live data connected/);
  const home = await (await fetch(`${BASE_PROD}/`)).text();
  assert.doesNotMatch(home, /Every active and dissolved UK company/);
  assert.doesNotMatch(home, /Connected to live Companies House data/);
});
