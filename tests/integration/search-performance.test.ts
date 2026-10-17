import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { api, db, group, rule, sessionFor } from "./helpers";
import { buildCompanyWhere, countCompanies, countRealCompanies, iterateCompanies, searchCompanies, SORTABLE_FIELDS, type SortableField } from "../../src/lib/data/companies";

// Regression tests for the 5.69M-scale query optimisations. Every optimised path
// is compared with the straightforward implementation it replaced (plain Prisma
// count / OFFSET pagination / filter-in-JS), on a small synthetic data set in the
// SCRATCH test database (the 5.69M timings were measured separately on real data).

const PREFIX = "PF"; // company numbers PF000001.. ; names "PERF TEST ..."
const N = 143; // odd on purpose: partial last page
const PAGE = 7;
const NOW = new Date("2026-10-06T00:00:00Z");
const STATUSES = ["active", "active", "active", "liquidation", "dissolved"];
const TYPES = ["ltd", "llp", "plc"];
const POSTCODES = ["LS1 4AB", "LS1 4AD", "LS2 9XY", "M1 1AA", "SW1A 2AA", "EC1A 1BB", "G1 2FF"];
const NAME_WORDS = ["ALPHA", "BRAVO", "CONSULT", "DELTA", "ECHO", "FOXTROT", "GOLF"];

const num = (i: number) => `${PREFIX}${String(i).padStart(6, "0")}`;
interface Row { companyNumber: string; name: string; status: string; type: string; incorporationDate: Date; registeredPostcode: string; dormant: boolean; hasDS01: boolean; accountsNextDue: Date | null; directorCount: number; accountsOverdue: boolean }
const rows: Row[] = Array.from({ length: N }, (_, k) => {
  const i = k + 1;
  return {
    companyNumber: num(i),
    name: `PERF TEST ${NAME_WORDS[i % NAME_WORDS.length]} ${i % 11} LTD`, // many duplicate-ish names -> ties
    status: STATUSES[i % STATUSES.length],
    type: TYPES[i % TYPES.length],
    incorporationDate: new Date(Date.UTC(2005 + (i % 20), i % 12, 1 + (i % 27))),
    registeredPostcode: POSTCODES[i % POSTCODES.length],
    dormant: i % 4 === 0,
    hasDS01: i % 9 === 0,
    accountsNextDue: i % 3 === 0 ? null : new Date(Date.UTC(2026, 10 + (i % 5), 1 + (i % 5))), // NULLs and ties
    directorCount: i % 4, // lots of ties; "not fetched" stays officersCoverage=none
    accountsOverdue: i % 6 === 0,
  };
});

before(async () => {
  await db.company.deleteMany({ where: { companyNumber: { startsWith: PREFIX } } });
  await db.company.createMany({
    data: rows.map((r) => ({
      ...r,
      registeredAddress1: "1 Perf Street",
      registeredCity: "Perfton",
      source: "bulk_import",
    })),
  });
});
after(async () => {
  await db.company.deleteMany({ where: { companyNumber: { startsWith: PREFIX } } });
  await db.$disconnect();
});

const mine = { companyNumber: { startsWith: PREFIX } };
const withMine = (extra: Record<string, unknown>) => ({ AND: [mine, extra] });
const ids = (rs: { companyNumber: string }[]) => rs.map((r) => r.companyNumber);

// ---- counts ------------------------------------------------------------------------------------------------
test("countCompanies equals Prisma count() for every kind of filter (AND / OR / nested / director / search)", async () => {
  const filters: unknown[] = [
    null,
    group("AND", rule("status", "equals", "active")),
    group("AND", rule("status", "equals", "active"), rule("registeredPostcode", "startsWith", "LS1")),
    group("OR", rule("hasDS01", "isTrue"), rule("dormant", "isTrue"), rule("status", "equals", "liquidation")),
    group("AND", group("OR", rule("type", "equals", "llp"), rule("type", "equals", "plc")), rule("companyAgeYears", "between", 2, 15)),
    group("AND", rule("directorCount", "equals", 1)),
    group("AND", rule("singleDirector", "isTrue")),
    group("AND", rule("accountsNextDue", "dateBetween", "2026-11-01", "2027-01-31")),
  ];
  for (const filter of filters) {
    for (const mode of ["confirmed", "possible"] as const) {
      const where = withMine(buildCompanyWhere({ filter, mode, scope: "all", userId: "no-such-user" }) as Record<string, unknown>);
      assert.equal(await countCompanies(where as never), await db.company.count({ where: where as never }), JSON.stringify(filter));
    }
  }
  const q = withMine(buildCompanyWhere({ q: "perf test" }) as Record<string, unknown>);
  assert.equal(await countCompanies(q as never), N);
  assert.equal(await countCompanies({ companyNumber: "NO-SUCH" }), 0);
});

test("countRealCompanies returns the real-company count and is memoised", async () => {
  const a = await countRealCompanies(60_000);
  assert.equal(a, await db.company.count({ where: { source: { not: "seed" } } }));
  await db.company.create({ data: { companyNumber: "PF999999", name: "PERF TEST MEMO", status: "active", type: "ltd", incorporationDate: NOW, registeredAddress1: "x", registeredCity: "x", registeredPostcode: "X1 1XX", source: "bulk_import" } });
  try {
    assert.equal(await countRealCompanies(60_000), a, "served from the memo inside the TTL");
    assert.equal(await countRealCompanies(0), a + 1, "ttl 0 recounts");
  } finally {
    await db.company.delete({ where: { companyNumber: "PF999999" } });
  }
});

// ---- search box: exact / partial number, exact / partial name, postcode -------------------------------------
const matchesQ = (r: Row, term: string) =>
  r.name.toLowerCase().includes(term.toLowerCase()) || r.companyNumber.includes(term.toUpperCase()) || r.registeredPostcode.includes(term.toUpperCase());
async function searchIds(q: string) {
  const where = withMine(buildCompanyWhere({ q, scope: "all", userId: "no-such-user" }) as Record<string, unknown>);
  const res = await searchCompanies({ where: where as never, page: 1, pageSize: 100, sortField: "companyNumber" });
  return { ids: ids(res.rows), total: res.total };
}
test("search box: exact number, partial number, exact name, partial name, postcode all return exactly the same companies as before", async () => {
  const cases = [num(57), "PF0000", "000057", "pf000057", rows[10].name, "perf test consult", "consult", "ZZZ-nothing", "LS1 4AD", "ls1 4a", "sw1a", "1A A"];
  for (const q of cases) {
    const expected = rows.filter((r) => matchesQ(r, q)).map((r) => r.companyNumber).sort();
    const got = await searchIds(q);
    assert.deepEqual([...got.ids].sort(), expected.slice(0, 100).sort(), `q=${q}`);
    assert.equal(got.total, expected.length, `total for q=${q}`);
  }
  const exact = await searchIds(num(57));
  assert.deepEqual(exact.ids, [num(57)]);
});

// ---- pagination: reverse-from-end must equal plain OFFSET for every sort -------------------------------------
// Written out by hand (not derived from SORT_DEFS) so the test checks the implementation against an independent spec.
function referenceOrder(field: SortableField, dir: "asc" | "desc") {
  const key = (f: string) => ({ [f]: dir });
  switch (field) {
    case "accountsNextDue":
      return [{ accountsNextDue: { sort: dir, nulls: "last" as const } }, { id: "asc" as const }];
    case "directorCount":
      return [{ officersCoverage: "asc" as const }, key("directorCount"), { id: "asc" as const }];
    case "filing":
      return [key("hasDS01"), key("accountsOverdue"), { accountsNextDue: { sort: dir, nulls: "last" as const } }, { id: "asc" as const }];
    default:
      return [key(field), { id: "asc" as const }];
  }
}
async function referencePage(where: object, field: SortableField, dir: "asc" | "desc", page: number) {
  return db.company.findMany({
    where: where as never,
    orderBy: referenceOrder(field, dir),
    skip: (page - 1) * PAGE,
    take: PAGE,
  });
}
for (const field of SORTABLE_FIELDS) {
  test(`pagination: every page (first / middle / last / beyond) is identical to plain OFFSET - sort ${field} asc+desc, reverse path forced`, async () => {
    for (const dir of ["asc", "desc"] as const) {
      for (const filter of [null, group("AND", rule("status", "equals", "active")), group("AND", rule("registeredPostcode", "startsWith", "ZZ"))]) {
        const where = withMine(buildCompanyWhere({ filter, scope: "all", userId: "no-such-user" }) as Record<string, unknown>);
        const total = await db.company.count({ where: where as never });
        const pages = Math.ceil(total / PAGE) + 2; // includes two pages past the end
        for (let page = 1; page <= pages; page++) {
          const ref = await referencePage(where, field, dir, page);
          // reverseFromSkip 0 forces the count-first / read-from-the-nearer-end branch on every page
          const forced = await searchCompanies({ where: where as never, sortField: field, sortDir: dir, page, pageSize: PAGE, reverseFromSkip: 0 });
          const normal = await searchCompanies({ where: where as never, sortField: field, sortDir: dir, page, pageSize: PAGE });
          assert.deepEqual(ids(forced.rows), ids(ref), `${field} ${dir} page ${page} (reverse path)`);
          assert.deepEqual(ids(normal.rows), ids(ref), `${field} ${dir} page ${page} (normal path)`);
          assert.equal(forced.total, total);
          assert.equal(normal.total, total);
          assert.equal(forced.pageCount, Math.max(1, Math.ceil(total / PAGE)));
        }
      }
    }
  });
}

test("pagination: pages never overlap and together cover the whole result exactly once (reverse path)", async () => {
  const where = withMine(buildCompanyWhere({ scope: "all", userId: "no-such-user" }) as Record<string, unknown>);
  const seen: string[] = [];
  for (let page = 1; page <= Math.ceil(N / PAGE); page++) {
    seen.push(...ids((await searchCompanies({ where: where as never, sortField: "name", page, pageSize: PAGE, reverseFromSkip: 0 })).rows));
  }
  assert.equal(seen.length, N);
  assert.equal(new Set(seen).size, N);
});

// ---- CSV export iteration ---------------------------------------------------------------------------------------
test("iterateCompanies yields exactly the matching rows once, in id order, in bounded batches, honouring maxRows", async () => {
  const where = withMine(buildCompanyWhere({ filter: group("AND", rule("status", "equals", "active")) }) as Record<string, unknown>) as never;
  const expected = await db.company.findMany({ where, select: { id: true, companyNumber: true }, orderBy: { id: "asc" } });
  const got: { id: string; companyNumber: string }[] = [];
  let maxBatch = 0;
  for await (const batch of iterateCompanies(where, 10)) {
    maxBatch = Math.max(maxBatch, batch.length);
    got.push(...batch);
  }
  assert.ok(maxBatch <= 10 && maxBatch > 0);
  assert.deepEqual(got.map((r) => r.id), expected.map((r) => r.id));
  const limited: string[] = [];
  for await (const batch of iterateCompanies(where, 10, 25)) limited.push(...batch.map((r) => r.id));
  assert.equal(limited.length, 25);
  const none: unknown[] = [];
  for await (const batch of iterateCompanies({ companyNumber: "NO-SUCH" } as never, 10)) none.push(batch);
  assert.equal(none.length, 0);
});

test("CSV export over HTTP: correct rows for a filter, header present, per-role row cap still enforced", async () => {
  const admin = await sessionFor("ADMIN");
  const small = await api(admin, "/api/companies/export", { body: { filter: group("AND", rule("name", "startsWith", "PERF TEST ALPHA 1"), rule("status", "equals", "active")) } });
  assert.equal(small.status, 200);
  const lines = small.text.trim().split("\r\n");
  const expected = rows.filter((r) => r.name.startsWith("PERF TEST ALPHA 1") && r.status === "active");
  assert.equal(lines.length, expected.length + 1, "header + one line per matching company");
  assert.match(lines[0], /^Company number,Name,Status/);
  assert.deepEqual(lines.slice(1).map((l) => l.split(",")[0]).sort(), expected.map((r) => r.companyNumber).sort());

  const user = await sessionFor("USER"); // test server caps USER exports at 50 rows
  const big = await api(user, "/api/companies/export", { body: { filter: group("AND", rule("name", "startsWith", "PERF TEST")) } });
  assert.equal(big.status, 413, "the row cap is still enforced");
  const bare = await api(user, "/api/companies/export", { body: {} });
  assert.equal(bare.status, 403, "a plain USER still cannot export the whole register");
});

test("search API still returns correct totals, pages and director-coverage counts end to end", async () => {
  const s = await sessionFor("USER");
  const res = await api(s, "/api/companies/search", { body: { q: "PERF TEST", page: 3, pageSize: 25, sortField: "companyNumber", sortDir: "desc" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, N);
  assert.equal(res.json.pageCount, Math.ceil(N / 25));
  assert.deepEqual(res.json.rows.map((r: { companyNumber: string }) => r.companyNumber), rows.map((r) => r.companyNumber).sort().reverse().slice(50, 75));
  const dir = await api(s, "/api/companies/search", { body: { q: "PERF TEST", filter: group("AND", rule("singleDirector", "isTrue")), page: 1, pageSize: 25 } });
  assert.equal(dir.json.total, 0, "unfetched officers are never counted as matches");
  assert.equal(dir.json.officerCoverage.unknown, N, "...they are reported as unknown instead");
});
