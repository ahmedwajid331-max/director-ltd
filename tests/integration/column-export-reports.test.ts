import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, api, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";
import { withSearchAsFilter } from "../../src/lib/filters/searchToFilter";
import { emptyFilterGroup } from "../../src/lib/filters/types";

after(async () => {
  await db.$disconnect();
});

// minimal CSV reader (handles quoted cells with commas / doubled quotes)
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      /* skip */
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const exportCsv = async (s: Session, body: unknown) => {
  const res = await fetch(`${BASE}/api/companies/export`, { method: "POST", headers: { "content-type": "application/json", cookie: `director_session=${s.cookie}` }, body: JSON.stringify(body) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
};
const nameFilter = (tag: string) => group("AND", rule("name", "contains", tag));

test("CSV export follows the chosen columns, in order, with the table's headings and the user's own markers", async () => {
  const u = await sessionFor("USER", "ex");
  const tag = `EXC${Date.now() % 1000000}`;
  const a = await makeCompany({ name: `${tag} ALPHA`, registeredCounty: "KENT", accountType: "micro-entity" });
  await makeCompany({ name: `${tag} BETA`, registeredCounty: null });
  await db.userCompanyState.create({ data: { userId: u.userId, companyId: a.id, followed: true } });

  const r = await exportCsv(u, { filter: nameFilter(tag), columns: ["name", "status", "followed", "registeredCounty", "accountType"] });
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const rows = parseCsv(r.text).filter((x) => x.length > 1);
  assert.deepEqual(rows[0], ["Company", "Status", "Followed", "County", "Accounts type"]);
  assert.equal(rows.length, 3);
  const alpha = rows.find((x) => x[0] === `${tag} ALPHA`)!;
  const beta = rows.find((x) => x[0] === `${tag} BETA`)!;
  assert.deepEqual(alpha, [`${tag} ALPHA`, "Active", "Yes", "KENT", "Micro entity"]);
  assert.deepEqual(beta.slice(2), ["No", "", "No accounts filed"]);
});

test("CSV export: the original 15-column format is unchanged when no columns are sent", async () => {
  const u = await sessionFor("USER", "exl");
  const tag = `EXL${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} ONE` });
  const r = await exportCsv(u, { filter: nameFilter(tag) });
  assert.equal(r.status, 200);
  assert.deepEqual(parseCsv(r.text)[0], ["Company number", "Name", "Status", "Type", "Incorporated", "Dormant", "City/Town", "Postcode", "Address", "Director count", "Single director", "Officer data as of", "Accounts overdue", "Confirmation overdue", "DS01 filed"]);
});

test("CSV export: unknown, restricted, internal and unavailable columns are never exported; Company is always first", async () => {
  const u = await sessionFor("USER", "exc");
  const tag = `EXC2${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} ONE` });
  const r = await exportCsv(u, { filter: nameFilter(tag), columns: ["status", "officerBirth", "previousNames", "createdAt", "officersDirtyAt", "pscNames", "bogus", "status"] });
  assert.equal(r.status, 200);
  assert.deepEqual(parseCsv(r.text)[0], ["Company", "Status"]);
  assert.ok(!/officer|birth|psc/i.test(parseCsv(r.text)[0].join(",")));
});

test("CSV export: a field switched off by Super Admin is not exported", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "exs");
  const u = await sessionFor("USER", "exs");
  const tag = `EXS${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} ONE`, registeredCounty: "ESSEX" });
  try {
    assert.equal((await api(sa, "/api/admin/columns/fields", { method: "PUT", body: { updates: [{ key: "registeredCounty", enabled: false }] } })).status, 200);
    const r = await exportCsv(u, { filter: nameFilter(tag), columns: ["name", "registeredCounty", "status"] });
    assert.deepEqual(parseCsv(r.text)[0], ["Company", "Status"]);
  } finally {
    await db.columnFieldSetting.deleteMany({ where: { key: "registeredCounty" } });
  }
});

test("CSV export: the same access rules apply (anonymous refused; a plain user must filter first; formulas neutralised)", async () => {
  const u = await sessionFor("USER", "exa");
  const anon = await fetch(`${BASE}/api/companies/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ columns: ["name"] }) });
  assert.equal(anon.status, 401);
  const noFilter = await exportCsv(u, { columns: ["name", "status"] });
  assert.equal(noFilter.status, 403);

  const tag = `EXF${Date.now() % 1000000}`;
  await makeCompany({ name: `=${tag} FORMULA`, registeredAddress1: "+cmd" });
  const r = await exportCsv(u, { filter: nameFilter(tag), columns: ["name", "registeredAddress1"] });
  const row = parseCsv(r.text)[1];
  assert.equal(row[0], `'=${tag} FORMULA`);
  assert.equal(row[1], "'+cmd");
});

test("CSV export: all 33 Phase 1 columns export for a company", async () => {
  const u = await sessionFor("USER", "ex33");
  const tag = `EX33${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} FULL` });
  const cfg = await api(u, "/api/columns/config");
  const cols: string[] = cfg.json.layouts.find((l: { isDefault: boolean }) => l.isDefault).columns;
  assert.equal(cols.length, 33);
  const r = await exportCsv(u, { filter: nameFilter(tag), columns: cols });
  const rows = parseCsv(r.text).filter((x) => x.length > 1);
  assert.equal(rows[0].length, 33);
  assert.equal(rows[1].length, 33);
  assert.equal(rows[0][0], "Company");
});

// ---- saved reports remember columns and sort ----------------------------------------------------------------

test("saved reports store, return and clear their columns and sort; old behaviour is unchanged", async () => {
  const u = await sessionFor("USER", "rp");
  const other = await sessionFor("USER", "rp2");
  const filter = group("AND", rule("status", "equals", "active"));

  const plain = await api(u, "/api/reports", { body: { name: "plain", filter } });
  assert.equal(plain.status, 200);
  const plainRow = await db.report.findUniqueOrThrow({ where: { id: plain.json.report.id } });
  assert.equal(plainRow.columnsJson, null, "a report saved without columns keeps the original table");
  assert.equal(plainRow.sortJson, null);

  const cols = ["name", "status", "registeredCounty", "accountsNextDue"];
  const made = await api(u, "/api/reports", { body: { name: "with columns", filter, columns: cols, sort: { field: "incorporationDate", dir: "desc" } } });
  assert.equal(made.status, 200);
  const row = await db.report.findUniqueOrThrow({ where: { id: made.json.report.id } });
  assert.deepEqual(JSON.parse(row.columnsJson!), cols);
  assert.deepEqual(JSON.parse(row.sortJson!), { field: "incorporationDate", dir: "desc" });
  assert.equal((await api(u, `/api/reports/${made.json.report.id}?page=1`)).status, 200);
  assert.equal((await fetch(`${BASE}/reports/${made.json.report.id}`, { headers: { cookie: `director_session=${u.cookie}` } })).status, 200);

  // rejected: restricted / unknown / unavailable / badly ordered columns, unsupported sorts
  for (const bad of [["name", "officerBirth"], ["status", "name"], ["name", "bogus"], ["name", "previousNames"], []]) {
    const r = await api(u, "/api/reports", { body: { name: "bad", filter, columns: bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await api(u, "/api/reports", { body: { name: "bad", filter, sort: { field: "followed", dir: "asc" } } })).status, 400); // per-user flags are not sort keys
  assert.equal((await api(u, "/api/reports", { body: { name: "ok-county", filter, sort: { field: "registeredCounty", dir: "asc" } } })).status, 200);
  assert.equal((await api(u, "/api/reports", { body: { name: "bad", filter, sort: { field: "name", dir: "sideways" } } })).status, 400);

  // update: change, then forget
  const id = made.json.report.id;
  const upd = await api(u, `/api/reports/${id}`, { method: "PATCH", body: { columns: ["name", "type"], sort: { field: "name", dir: "desc" } } });
  assert.equal(upd.status, 200);
  const r2 = await db.report.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(JSON.parse(r2.columnsJson!), ["name", "type"]);
  assert.deepEqual(JSON.parse(r2.sortJson!), { field: "name", dir: "desc" });
  assert.equal((await api(u, `/api/reports/${id}`, { method: "PATCH", body: { name: "renamed" } })).status, 200);
  assert.deepEqual(JSON.parse((await db.report.findUniqueOrThrow({ where: { id } })).columnsJson!), ["name", "type"], "an unrelated edit leaves columns alone");
  assert.equal((await api(u, `/api/reports/${id}`, { method: "PATCH", body: { columns: null, sort: null } })).status, 200);
  const r3 = await db.report.findUniqueOrThrow({ where: { id } });
  assert.equal(r3.columnsJson, null);
  assert.equal(r3.sortJson, null);

  // only the owner can change a report
  assert.equal((await api(other, `/api/reports/${id}`, { method: "PATCH", body: { columns: ["name", "type"] } })).status, 404);
  await db.report.deleteMany({ where: { ownerId: u.userId } });
});

// ---- search box and A-Z letter saved as filter rules ---------------------------------------------------------

test("a saved report matches exactly what the search box and A-Z letter showed", async () => {
  const u = await sessionFor("USER", "sq");
  const t = `${Date.now() % 100000}`;
  await makeCompany({ name: `QUASAR ${t} LTD`, registeredPostcode: "ZZ9 9ZZ", status: "active" });
  await makeCompany({ name: `QUILL ${t} LTD`, registeredPostcode: "ZZ9 1AA", status: "liquidation" });
  const rr = await makeCompany({ name: `RAVEN ${t} LTD`, registeredPostcode: "QU1 2AB", status: "active" });
  await makeCompany({ name: `OTHER ${t} LTD`, registeredPostcode: "AB1 1AB", status: "active" });

  const cases: { q?: string; letter?: string; base?: ReturnType<typeof group> }[] = [
    { q: `${t}` },
    { q: "qu" },
    { q: "zz9" },
    { q: rr.companyNumber.toLowerCase() },
    { letter: "Q" },
    { letter: "Q", q: t },
    { q: t, base: group("AND", rule("status", "equals", "active")) },
    { letter: "R", q: "qu", base: group("AND", rule("status", "equals", "active")) },
  ];
  for (const c of cases) {
    const direct = await api(u, "/api/companies/search", { body: { filter: c.base ?? emptyFilterGroup(), q: c.q, namePrefix: c.letter, page: 1, pageSize: 100, sortField: "name", sortDir: "asc" } });
    const converted = await api(u, "/api/companies/search", { body: { filter: withSearchAsFilter((c.base as never) ?? emptyFilterGroup(), c.q, c.letter), page: 1, pageSize: 100, sortField: "name", sortDir: "asc" } });
    assert.equal(direct.status, 200, JSON.stringify(c));
    assert.equal(converted.status, 200, JSON.stringify(c));
    assert.equal(converted.json.total, direct.json.total, `count for ${JSON.stringify(c)}`);
    assert.deepEqual(converted.json.rows.map((x: { id: string }) => x.id), direct.json.rows.map((x: { id: string }) => x.id), `rows for ${JSON.stringify(c)}`);
  }
});

// ---- the three new date filters ---------------------------------------------------------------------------

test("the new date filters (accounts last made up, confirmation due, confirmation last made up) match the right companies", async () => {
  const u = await sessionFor("USER", "df");
  const tag = `DF${Date.now() % 1000000}`;
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const a = await makeCompany({ name: `${tag} A`, accountsLastMadeUp: d("2025-03-31"), confirmationNextDue: d("2026-11-10"), confirmationLastMadeUp: d("2025-11-10") });
  const b = await makeCompany({ name: `${tag} B`, accountsLastMadeUp: d("2026-03-31"), confirmationNextDue: d("2027-02-01"), confirmationLastMadeUp: d("2026-02-01") });
  const c = await makeCompany({ name: `${tag} C`, accountsLastMadeUp: null, confirmationNextDue: null, confirmationLastMadeUp: null });
  const ids = async (field: string, op: string, v: string, v2?: string) => {
    const r = await api(u, "/api/companies/search", { body: { filter: group("AND", rule("name", "contains", tag), rule(field, op, v, v2)), page: 1, pageSize: 50, sortField: "name", sortDir: "asc" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.rows.map((x: { id: string }) => x.id);
  };
  assert.deepEqual(await ids("accountsLastMadeUp", "before", "2026-01-01"), [a.id]);
  assert.deepEqual(await ids("accountsLastMadeUp", "after", "2025-12-31"), [b.id]);
  assert.deepEqual(await ids("confirmationNextDue", "dateBetween", "2026-11-01", "2027-03-01"), [a.id, b.id]);
  assert.deepEqual(await ids("confirmationNextDue", "before", "2027-01-01"), [a.id]);
  assert.deepEqual(await ids("confirmationLastMadeUp", "after", "2026-01-01"), [b.id]);
  // companies with no date never match a date condition
  for (const f of ["accountsLastMadeUp", "confirmationNextDue", "confirmationLastMadeUp"]) {
    assert.ok(!(await ids(f, "dateBetween", "1990-01-01", "2100-01-01")).includes(c.id), f);
  }
  // bad input is rejected, not silently ignored
  const bad = await api(u, "/api/companies/search", { body: { filter: group("AND", rule("confirmationNextDue", "before", "tomorrow")), page: 1 } });
  assert.equal(bad.status, 400);
});

// ---- export scope: matches the table ------------------------------------------------------------------------

test("export from the main Companies view matches the table (own Trash hidden), and the all view is not a way around the filter rule", async () => {
  const u = await sessionFor("USER", "exsc");
  const tag = `EXSC${Date.now() % 1000000}`;
  const keep = await makeCompany({ name: `${tag} KEEP` });
  const trashed = await makeCompany({ name: `${tag} TRASHED` });
  await db.userCompanyState.create({ data: { userId: u.userId, companyId: trashed.id, trashed: true } });

  const names = (r: { text: string }) => parseCsv(r.text).slice(1).filter((x) => x.length > 1).map((x) => x[0]).sort();
  const asTable = await exportCsv(u, { filter: nameFilter(tag), scope: "all", columns: ["name"] });
  assert.deepEqual(names(asTable), [`${tag} KEEP`], "the table hides the user's trashed company, so the export does too");
  const asReport = await exportCsv(u, { filter: nameFilter(tag), columns: ["name"] });
  assert.deepEqual(names(asReport), [`${tag} KEEP`, `${tag} TRASHED`], "report-style export (no view) is unchanged");
  const trashView = await exportCsv(u, { filter: nameFilter(tag), scope: "trashed", columns: ["name"] });
  assert.deepEqual(names(trashView), [`${tag} TRASHED`]);
  assert.ok(keep.id);

  // "all" does not count as narrowing the register: a plain user still has to filter or search first
  assert.equal((await exportCsv(u, { scope: "all", columns: ["name"] })).status, 403);
  assert.equal((await exportCsv(u, { scope: "all" })).status, 403);
  assert.equal((await exportCsv(u, { scope: "trashed", columns: ["name"] })).status, 200);
});
