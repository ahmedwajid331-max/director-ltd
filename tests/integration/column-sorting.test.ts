import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";
import { SORTABLE_FIELDS, SORT_DEFS } from "../../src/lib/data/companies";

after(async () => {
  await db.$disconnect();
});

type Row = Record<string, unknown> & { id: string; name: string; status: string; type: string; companyNumber: string; officersCoverage: string; directorCount: number; hasDS01: boolean; accountsOverdue: boolean; accountsNextDue: string | null };
let seq = 0;
const search = (s: Session, tag: string, body: Record<string, unknown> = {}) =>
  api(s, "/api/companies/search", { body: { page: 1, pageSize: 100, filter: group("AND", rule("name", "startsWith", tag)), ...body } });

// Twelve companies with distinct values in every sortable column, plus null / unconfirmed edge cases.
async function fixture() {
  const tag = `SORT${Date.now() % 10000000}`;
  const s = await sessionFor("USER", "sorter");
  const u = String((Date.now() % 90000) + ++seq).padStart(5, "0"); // keeps company numbers unique across fixtures
  const defs: Record<string, unknown>[] = [
    { n: "A", registeredCity: "Leeds", companyNumber: `0${u}1`, status: "active", type: "ltd", registeredPostcode: "AB1 1AA", incorporationDate: new Date("2001-01-01"), officersCoverage: "full", directorCount: 3, hasDS01: false, accountsOverdue: false, accountsNextDue: new Date("2027-03-01") },
    { n: "B", registeredCity: "Aberdeen", companyNumber: `SC${u}2`, status: "dissolved", type: "plc", registeredPostcode: "CD2 2BB", incorporationDate: new Date("2005-05-05"), officersCoverage: "full", directorCount: 1, hasDS01: true, accountsOverdue: false, accountsNextDue: new Date("2026-12-01") },
    { n: "C", registeredCity: "London", companyNumber: `NI${u}3`, status: "liquidation", type: "llp", registeredPostcode: "EF3 3CC", incorporationDate: new Date("2010-10-10"), officersCoverage: "full", directorCount: 5, hasDS01: false, accountsOverdue: true, accountsNextDue: null },
    { n: "D", registeredCity: "", companyNumber: `0${u}4`, status: "closed", type: "private-unlimited", registeredPostcode: "GH4 4DD", incorporationDate: new Date("2015-02-02"), officersCoverage: "none", directorCount: 0, hasDS01: false, accountsOverdue: false, accountsNextDue: new Date("2028-01-01") },
    { n: "E", registeredCity: "Bath", companyNumber: `OC${u}5`, status: "administration", type: "uk-establishment", registeredPostcode: "IJ5 5EE", incorporationDate: new Date("2020-03-03"), officersCoverage: "unavailable", directorCount: 0, hasDS01: true, accountsOverdue: true, accountsNextDue: new Date("2026-11-01") },
  ];
  const cs: { id: string }[] = [];
  for (const d of defs) {
    const { n, ...rest } = d;
    cs.push(await makeCompany({ name: `${tag} ${n}`, ...rest }));
  }
  return { tag, s, cs };
}

const valueOf = (field: string, r: Row): unknown => {
  switch (field) {
    case "filing":
      return [r.hasDS01, r.accountsOverdue, r.accountsNextDue ?? "~"];
    default:
      return r[field];
  }
};

test("every sortable column has a definition and sorts ascending and descending on the server", async () => {
  assert.deepEqual([...SORTABLE_FIELDS].sort(), Object.keys(SORT_DEFS).sort(), "SORT_DEFS covers exactly SORTABLE_FIELDS");
  const { tag, s } = await fixture();
  for (const field of SORTABLE_FIELDS) {
    const asc = await search(s, tag, { sortField: field, sortDir: "asc" });
    const desc = await search(s, tag, { sortField: field, sortDir: "desc" });
    assert.equal(asc.status, 200, `${field} asc: ${asc.text.slice(0, 120)}`);
    assert.equal(desc.status, 200, `${field} desc`);
    const a = asc.json.rows.map((r: Row) => r.name);
    const d = desc.json.rows.map((r: Row) => r.name);
    assert.equal(a.length, 5);
    assert.deepEqual([...a].sort(), [...d].sort(), `${field}: same rows both ways`);
    if (["name", "companyNumber", "status", "type", "incorporationDate", "registeredPostcode"].includes(field)) {
      // Strict columns (no NULL / unconfirmed handling): descending is exactly the reverse of ascending.
      assert.deepEqual(a, [...d].reverse(), `${field}: desc is the reverse of asc`);
    }
  }
});

test("name, status, type, postcode, incorporated and company number order correctly (letters in numbers included)", async () => {
  const { tag, s } = await fixture();
  const order = async (field: string, dir: string) => (await search(s, tag, { sortField: field, sortDir: dir })).json.rows.map((r: Row) => r.name.slice(-1)).join("");
  assert.equal(await order("name", "asc"), "ABCDE");
  assert.equal(await order("name", "desc"), "EDCBA");
  assert.equal(await order("incorporationDate", "desc"), "EDCBA");
  assert.equal(await order("registeredPostcode", "asc"), "ABCDE");
  const statuses = (await search(s, tag, { sortField: "status", sortDir: "asc" })).json.rows.map((r: Row) => r.status);
  assert.deepEqual(statuses, [...statuses].sort());
  const types = (await search(s, tag, { sortField: "type", sortDir: "asc" })).json.rows.map((r: Row) => r.type);
  assert.deepEqual(types, [...types].sort());
  const numbers = (await search(s, tag, { sortField: "companyNumber", sortDir: "asc" })).json.rows.map((r: Row) => r.companyNumber);
  assert.deepEqual(numbers, [...numbers].sort(), "company numbers sort as text");
  assert.ok(numbers.some((n: string) => /[A-Z]/.test(n)), "fixture includes lettered company numbers");
});

test("directors: confirmed counts sort numerically; unconfirmed companies come last in BOTH directions and are never ranked as 0", async () => {
  const { tag, s } = await fixture();
  for (const dir of ["asc", "desc"] as const) {
    const rows = (await search(s, tag, { sortField: "directorCount", sortDir: dir })).json.rows as Row[];
    const confirmed = rows.filter((r) => r.officersCoverage === "full").map((r) => r.directorCount);
    assert.deepEqual(confirmed, dir === "asc" ? [1, 3, 5] : [5, 3, 1], `confirmed counts ${dir}`);
    assert.deepEqual(rows.slice(0, 3).map((r) => r.officersCoverage), ["full", "full", "full"], `confirmed first (${dir})`);
    assert.deepEqual(rows.slice(3).map((r) => r.officersCoverage).sort(), ["none", "unavailable"], `unconfirmed last (${dir})`);
  }
});

test("accounts due and filing sort with NULLs last and a deterministic order", async () => {
  const { tag, s } = await fixture();
  for (const dir of ["asc", "desc"] as const) {
    const due = (await search(s, tag, { sortField: "accountsNextDue", sortDir: dir })).json.rows as Row[];
    assert.equal(due[due.length - 1].accountsNextDue, null, `NULL due date last (${dir})`);
  }
  const filing = (await search(s, tag, { sortField: "filing", sortDir: "desc" })).json.rows as Row[];
  // DS01 filed first (B and E), then late accounts (C), then the rest.
  assert.deepEqual(filing.slice(0, 2).map((r) => r.hasDS01), [true, true]);
  assert.equal(filing[2].accountsOverdue, true);
  const again = (await search(s, tag, { sortField: "filing", sortDir: "desc" })).json.rows.map((r: Row) => r.id);
  assert.deepEqual(again, filing.map((r) => r.id), "stable across requests");
  void valueOf;
});

test("pagination preserves the sort order across pages for every column, both directions", async () => {
  const { tag, s } = await fixture();
  for (const field of SORTABLE_FIELDS) {
    for (const dir of ["asc", "desc"] as const) {
      const whole = (await search(s, tag, { sortField: field, sortDir: dir })).json.rows.map((r: Row) => r.id);
      const paged: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const r = await search(s, tag, { sortField: field, sortDir: dir, page, pageSize: 2 });
        paged.push(...r.json.rows.map((x: Row) => x.id));
      }
      assert.deepEqual(paged, whole, `${field} ${dir}: pages concatenate to the full ordering`);
    }
  }
});

test("reading a page from the far end (reverse path) gives the identical order for every column", async () => {
  // Force the reverse-read branch through the API by paging past half of a result set via direct comparison of
  // forward and reverse definitions: SORT_DEFS drives both, so check the derived orders are exact mirrors.
  const { searchCompanies, buildCompanyWhere } = await import("../../src/lib/data/companies");
  const { tag } = await fixture();
  const where = buildCompanyWhere({ filter: group("AND", rule("name", "startsWith", tag)) });
  for (const field of SORTABLE_FIELDS) {
    for (const dir of ["asc", "desc"] as const) {
      const fwd = await searchCompanies({ where, sortField: field, sortDir: dir, page: 3, pageSize: 2, reverseFromSkip: 1_000_000 });
      const rev = await searchCompanies({ where, sortField: field, sortDir: dir, page: 3, pageSize: 2, reverseFromSkip: 0 });
      assert.deepEqual(rev.rows.map((r) => r.id), fwd.rows.map((r) => r.id), `${field} ${dir}`);
    }
  }
});

test("sorting combines with search, A-Z, filters, CRM filters and saved scope", async () => {
  const { tag, s, cs } = await fixture();
  for (const i of [0, 1, 4]) await api(s, `/api/companies/${cs[i].id}/state`, { body: { saved: true } });
  const names = (r: { json: { rows: Row[] } }) => r.json.rows.map((x) => x.name.slice(-1)).join("");

  // search + sort
  assert.equal(names(await api(s, "/api/companies/search", { body: { page: 1, pageSize: 100, q: tag, sortField: "incorporationDate", sortDir: "desc" } })), "EDCBA");
  // A-Z + sort (letter S matches the SORT prefix)
  assert.equal(names(await api(s, "/api/companies/search", { body: { page: 1, pageSize: 100, q: tag, namePrefix: "S", sortField: "name", sortDir: "desc" } })), "EDCBA");
  // filter + sort
  const active = group("AND", rule("name", "startsWith", tag), rule("directorCount", "gte", 1));
  assert.equal(names(await search(s, tag, { filter: active, sortField: "directorCount", sortDir: "desc" })), "CAB");
  // OR group + sort
  const either = group("AND", rule("name", "startsWith", tag), group("OR", rule("hasDS01", "isTrue"), rule("accountsOverdue", "isTrue")));
  assert.equal(names(await search(s, tag, { filter: either, sortField: "type", sortDir: "asc" })).split("").sort().join(""), "BCE");
  assert.deepEqual((await search(s, tag, { filter: either, sortField: "type", sortDir: "asc" })).json.rows.map((r: Row) => r.type), ["llp", "plc", "uk-establishment"]);
  assert.equal((await search(s, tag, { filter: either, sortField: "filing", sortDir: "desc" })).json.total, 3);
  // CRM filter + sort
  const crm = group("AND", rule("name", "startsWith", tag), rule("saved", "isTrue"));
  assert.equal(names(await search(s, tag, { filter: crm, sortField: "incorporationDate", sortDir: "asc" })), "ABE");
  // saved scope + sort
  assert.equal(names(await search(s, tag, { scope: "saved", sortField: "name", sortDir: "desc" })), "EBA");
});

test("an unknown sort field falls back to the default instead of failing", async () => {
  const { tag, s } = await fixture();
  const r = await search(s, tag, { sortField: "passwordHash", sortDir: "asc" });
  assert.equal(r.status, 200);
  assert.equal(r.json.rows.map((x: Row) => x.name.slice(-1)).join(""), "ABCDE", "falls back to company name A-Z");
});

test("city / town and postcode are separate columns: city sorts A-Z / Z-A server-side with blank cities last in BOTH directions", async () => {
  const { tag, s } = await fixture();
  const names = async (field: string, dir: string) => (await search(s, tag, { sortField: field, sortDir: dir })).json.rows.map((r: Row) => r.name.slice(-1)).join("");
  // Aberdeen(B) Bath(E) Leeds(A) London(C) then the blank city (D)
  assert.equal(await names("registeredCity", "asc"), "BEACD");
  // London(C) Leeds(A) Bath(E) Aberdeen(B) then the blank city (D) still last
  assert.equal(await names("registeredCity", "desc"), "CAEBD");
  // the rows carry the two values independently (never a combined location)
  const rows = (await search(s, tag, { sortField: "registeredCity", sortDir: "asc" })).json.rows as Row[];
  const b = rows.find((r) => r.name.endsWith(" B"))!;
  assert.equal(b.registeredCity, "Aberdeen");
  assert.equal(b.registeredPostcode, "CD2 2BB");
  // postcode sort is unaffected by the city values
  assert.equal(await names("registeredPostcode", "asc"), "ABCDE");
});

test("city filter and postcode filter are independent, and the global search still matches the postcode but not the city", async () => {
  const { tag, s } = await fixture();
  const inTag = (r: Row) => r.name.startsWith(tag);
  // City filter: only the stored city; "CD2" is a postcode so it must not match as a city
  const city = await search(s, tag, { filter: group("AND", rule("name", "startsWith", tag), rule("registeredCity", "contains", "lon")) });
  assert.deepEqual(city.json.rows.filter(inTag).map((r: Row) => r.name.slice(-1)), ["C"]);
  const cityByPostcode = await search(s, tag, { filter: group("AND", rule("name", "startsWith", tag), rule("registeredCity", "contains", "CD2")) });
  assert.equal(cityByPostcode.json.rows.length, 0, "city filter must not search the postcode");
  // Postcode filter: only the stored postcode; a city name must not match
  const pc = await search(s, tag, { filter: group("AND", rule("name", "startsWith", tag), rule("registeredPostcode", "startsWith", "cd2")) });
  assert.deepEqual(pc.json.rows.map((r: Row) => r.name.slice(-1)), ["B"]);
  const pcByCity = await search(s, tag, { filter: group("AND", rule("name", "startsWith", tag), rule("registeredPostcode", "startsWith", "Lon")) });
  assert.equal(pcByCity.json.rows.length, 0, "postcode filter must not search the city");
  // Global search: postcode matches, city name does not (existing behaviour preserved)
  const q1 = await api(s, "/api/companies/search", { body: { page: 1, pageSize: 50, q: "EF3 3CC" } });
  assert.ok(q1.json.rows.some((r: Row) => r.name.endsWith(" C")), "search by postcode still works");
  const q2 = await api(s, "/api/companies/search", { body: { page: 1, pageSize: 50, q: "Aberdeen", filter: group("AND", rule("name", "startsWith", tag)) } });
  assert.equal(q2.json.rows.length, 0, "global search does not search the city");
  // sort + filter + page 2 stay consistent
  const p1 = await search(s, tag, { sortField: "registeredCity", sortDir: "asc", pageSize: 2, page: 1 });
  const p2 = await search(s, tag, { sortField: "registeredCity", sortDir: "asc", pageSize: 2, page: 2 });
  assert.deepEqual([...p1.json.rows, ...p2.json.rows].map((r: Row) => r.name.slice(-1)).join(""), "BEAC", "pagination keeps the city order");
});

test("CSV export has separate City/Town and Postcode columns", async () => {
  const { tag, s } = await fixture();
  const exp = await api(s, "/api/companies/export", { body: { filter: group("AND", rule("name", "startsWith", tag)) } });
  assert.equal(exp.status, 200);
  const lines = exp.text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const ci = header.indexOf("City/Town");
  const pi = header.indexOf("Postcode");
  assert.ok(ci > 0 && pi === ci + 1, `header has City/Town then Postcode: ${lines[0]}`);
  const b = lines.find((l) => l.includes(`${tag} B`))!;
  assert.match(b, /,Aberdeen,CD2 2BB,/);
});

// The columns after Age (Status detail ... Profile fetched): each sorts on the server, by its real type, with blank / NULL last.
test("stored columns after Age: text by value, dates as dates, booleans No before Yes, blanks and NULLs last in both directions", async () => {
  const tag = `COLS${Date.now() % 10000000}`;
  const s = await sessionFor("USER", "colsorter");
  const defs: Record<string, unknown>[] = [
    { n: "A", registeredAddress2: "Flat 1", sicCodes: "62012", dissolutionDate: new Date("2022-02-02"), chLastFetchedAt: new Date("2026-01-03T00:00:00Z"), hasDS01: false, dormant: true, source: "stream", statusDetail: "active-proposal-to-strike-off" },
    { n: "B", registeredAddress2: "Flat 3", sicCodes: "", dissolutionDate: new Date("2020-01-01"), chLastFetchedAt: new Date("2026-01-01T00:00:00Z"), hasDS01: true, dormant: false, source: "bulk_import", statusDetail: "" },
    { n: "C", registeredAddress2: null, sicCodes: "47110", dissolutionDate: null, chLastFetchedAt: null, hasDS01: false, dormant: false, source: "rest_enrichment", statusDetail: null },
    { n: "D", registeredAddress2: "", sicCodes: "68100", dissolutionDate: null, chLastFetchedAt: new Date("2026-01-02T00:00:00Z"), hasDS01: true, dormant: true, source: "seed", statusDetail: "x-detail" },
    { n: "E", registeredAddress2: "Flat 2", sicCodes: "01110", dissolutionDate: new Date("2021-06-06"), chLastFetchedAt: new Date("2025-12-31T00:00:00Z"), hasDS01: false, dormant: false, source: "advanced_search", statusDetail: "b-detail" },
  ];
  for (const d of defs) {
    const { n, ...rest } = d;
    await makeCompany({ name: `${tag} ${n}`, ...rest });
  }
  const order = async (field: string, dir: string, extra: Record<string, unknown> = {}) => {
    const r = await search(s, tag, { sortField: field, sortDir: dir, ...extra });
    assert.equal(r.status, 200, `${field} ${dir}`);
    return r.json.rows.map((x: Row) => x.name.slice(-1)).join("");
  };

  // Text: real values ascending / descending, then the blank and NULL ones (C = NULL, D = "") last either way.
  const a2 = await order("registeredAddress2", "asc");
  assert.equal(a2.slice(0, 3), "AEB");
  assert.deepEqual([...a2.slice(3)].sort(), ["C", "D"]);
  const a2d = await order("registeredAddress2", "desc");
  assert.equal(a2d.slice(0, 3), "BEA");
  assert.deepEqual([...a2d.slice(3)].sort(), ["C", "D"]);
  assert.equal(await order("sicCodes", "asc"), "ECADB", "SIC asc, blank last");
  assert.equal(await order("sicCodes", "desc"), "DACEB", "SIC desc, blank still last");
  const sd = await order("statusDetail", "asc");
  assert.equal(sd.slice(0, 3), "AED");
  assert.deepEqual([...sd.slice(3)].sort(), ["B", "C"]);

  // Dates sort as dates; NULL last in both directions.
  assert.equal((await order("dissolutionDate", "asc")).slice(0, 3), "BEA");
  assert.equal((await order("dissolutionDate", "desc")).slice(0, 3), "AEB");
  assert.deepEqual([...(await order("dissolutionDate", "asc")).slice(3)].sort(), ["C", "D"]);
  assert.deepEqual([...(await order("dissolutionDate", "desc")).slice(3)].sort(), ["C", "D"]);
  assert.equal((await order("chLastFetchedAt", "asc")).slice(0, 4), "EBDA");
  assert.equal((await order("chLastFetchedAt", "desc")).slice(0, 4), "ADBE");
  assert.equal((await order("chLastFetchedAt", "asc")).slice(4), "C");
  assert.equal((await order("chLastFetchedAt", "desc")).slice(4), "C");

  // Booleans: No before Yes ascending, Yes before No descending (ties keep a stable id order).
  const flags = async (field: string, dir: string) => (await search(s, tag, { sortField: field, sortDir: dir })).json.rows.map((x: Row) => Boolean(x[field]));
  assert.deepEqual(await flags("hasDS01", "asc"), [false, false, false, true, true]);
  assert.deepEqual(await flags("hasDS01", "desc"), [true, true, false, false, false]);
  assert.deepEqual(await flags("dormant", "asc"), [false, false, false, true, true]);

  // Source is plain text.
  assert.equal(await order("source", "asc"), "EBCDA");

  // Pagination keeps the order: pages of 2 concatenate to the full ordering, for the blank-last text path too.
  for (const field of ["registeredAddress2", "sicCodes", "dissolutionDate", "hasDS01"]) {
    for (const dir of ["asc", "desc"]) {
      const whole = await order(field, dir);
      let paged = "";
      for (let page = 1; page <= 3; page++) paged += await order(field, dir, { page, pageSize: 2 });
      assert.equal(paged, whole, `${field} ${dir} across pages`);
    }
  }

  // Per-user flags and derived columns are not sort keys: an invalid key falls back to the default name order.
  assert.equal(await order("followed", "asc"), "ABCDE");
  assert.equal(await order("fullAddress", "asc"), "ABCDE");
});
