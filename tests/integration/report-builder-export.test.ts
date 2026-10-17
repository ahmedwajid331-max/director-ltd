import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yauzl from "yauzl";
import { api, BASE, createUser, db, group, login, makeCompany, rule, sessionFor, STRONG_PASSWORD, type Session } from "./helpers";

// Report Builder "Export" (no saved report needed): Excel, CSV, PDF, Word of the CURRENT results.
// Scratch database only (helpers import the scratch-DB guard first).

after(async () => {
  await db.$disconnect();
});

const exportDoc = (s: Session | null, body: unknown) =>
  fetch(`${BASE}/api/reports/export`, { method: "POST", headers: { "content-type": "application/json", ...(s ? { cookie: `director_session=${s.cookie}` } : {}) }, body: JSON.stringify(body) });
const exportCsv = (s: Session, body: unknown) =>
  fetch(`${BASE}/api/companies/export`, { method: "POST", headers: { "content-type": "application/json", cookie: `director_session=${s.cookie}` }, body: JSON.stringify(body) });

function unzip(buf: Buffer, wanted: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on("entry", (e) => {
        if (e.fileName !== wanted) return zip.readEntry();
        zip.openReadStream(e, (err2, st) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          st.on("data", (d) => parts.push(d));
          st.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        });
      });
      zip.on("end", () => reject(new Error(`no ${wanted}`)));
    });
  });
}
// The text of every cell in the Companies sheet, row by row.
const sheetRows = (xml: string) => [...xml.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map((m) => [...m[1].matchAll(/<(?:t[^>]*|v)>([^<]*)<\/(?:t|v)>/g)].map((c) => c[1]));
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function userWithPermissions(permissions: string[]): Promise<Session> {
  const user = await createUser("USER", "perm");
  await db.user.update({ where: { id: user.id }, data: { permissions: JSON.stringify(permissions) } });
  const r = await login(user.email, STRONG_PASSWORD);
  if (!r.cookie) throw new Error("login failed");
  return { cookie: r.cookie, userId: user.id, email: user.email };
}

test("Excel / PDF / Word / CSV export the current filtered results (AND, OR and nested) without saving a report", async () => {
  const s = await sessionFor("USER");
  const tag = `BX${Date.now() % 1000000}`;
  for (const [n, status] of [["B alpha", "active"], ["A alpha", "active"], ["C beta", "active"], ["D alpha dissolved", "dissolved"], ["E gamma", "active"]] as const) {
    await makeCompany({ name: `${tag} ${n}`, status });
  }
  const before = await db.report.count({ where: { ownerId: s.userId } });

  // AND: name starts with tag AND status active AND name contains "alpha" -> A alpha, B alpha only
  const andFilter = group("AND", rule("name", "startsWith", tag), rule("status", "equals", "active"), rule("name", "contains", "alpha"));
  const x = await exportDoc(s, { format: "xlsx", filter: andFilter, columns: ["name", "companyNumber", "status"], sortField: "name", sortDir: "desc", name: "My export" });
  assert.equal(x.status, 200);
  assert.equal(x.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(x.headers.get("content-disposition") ?? "", /filename="My-export-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), "PK");
  const rows = sheetRows(await unzip(buf, "xl/worksheets/sheet1.xml"));
  assert.deepEqual(rows[0], ["Company", "Company No.", "Status"], "chosen columns, proper headings");
  assert.deepEqual(rows.slice(1).map((r) => unesc(r[0])), [`${tag} B alpha`, `${tag} A alpha`], "only the matching companies, sorted descending");
  const details = await unzip(buf, "xl/worksheets/sheet2.xml");
  assert.ok(details.includes("My export") && details.includes("Matching companies") && details.includes("<v>2</v>"), "details sheet");

  // OR: (alpha-but-not-dissolved handled by status) -> name contains beta OR name contains gamma
  const orFilter = group("AND", rule("name", "startsWith", tag), group("OR", rule("name", "contains", "beta"), rule("name", "contains", "gamma")));
  const o = await exportDoc(s, { format: "xlsx", filter: orFilter, columns: ["name"], sortField: "name", sortDir: "asc" });
  assert.equal(o.status, 200);
  const orRows = sheetRows(await unzip(Buffer.from(await o.arrayBuffer()), "xl/worksheets/sheet1.xml"));
  assert.deepEqual(orRows.slice(1).map((r) => unesc(r[0])), [`${tag} C beta`, `${tag} E gamma`], "OR / nested group respected");

  // The very same filter in the other formats
  const w = await exportDoc(s, { format: "docx", filter: andFilter, columns: ["name", "status"] });
  assert.equal(w.status, 200);
  assert.equal(w.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const wxml = await unzip(Buffer.from(await w.arrayBuffer()), "word/document.xml");
  assert.ok(wxml.includes("Matching companies: 2"));
  assert.ok(wxml.includes(`${tag} A alpha`) && wxml.includes(`${tag} B alpha`) && !wxml.includes("dissolved") && !wxml.includes("beta"));

  const p = await exportDoc(s, { format: "pdf", filter: andFilter });
  assert.equal(p.status, 200);
  assert.equal(p.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

  const c = await exportCsv(s, { filter: andFilter, columns: ["name", "companyNumber", "status"] });
  assert.equal(c.status, 200);
  const lines = (await c.text()).trim().split(/\r?\n/);
  assert.equal(lines.length, 3, "header + the same two companies");
  assert.ok(lines[0].startsWith("Company"));
  assert.ok(lines.slice(1).some((l) => l.includes(`${tag} A alpha`)) && lines.slice(1).some((l) => l.includes(`${tag} B alpha`)));

  // Exporting never creates or changes a saved report; it is audited as an unsaved export.
  assert.equal(await db.report.count({ where: { ownerId: s.userId } }), before, "no report was saved");
  const logged = await db.activityLog.findMany({ where: { userId: s.userId, action: { in: ["export_xlsx", "export_pdf", "export_docx"] } } });
  assert.ok(logged.length >= 4);
  assert.ok(logged.every((l) => l.reportId === null && (l.meta ?? "").includes('"unsaved":true')));
});

test("every format refuses above the row limit instead of exporting a partial result", async () => {
  const s = await sessionFor("USER");
  const tag = `BL${Date.now() % 1000000}`;
  // The integration server caps a USER export at 50 rows.
  for (let i = 0; i < 52; i++) await makeCompany({ name: `${tag} ${String(i).padStart(2, "0")}` });
  const filter = group("AND", rule("name", "startsWith", tag));
  for (const format of ["xlsx", "pdf", "docx"]) {
    const r = await exportDoc(s, { format, filter });
    assert.equal(r.status, 413, format);
    assert.match(r.headers.get("content-type") ?? "", /json/, `${format}: an error, not a file`);
    const body = await r.json();
    assert.match(body.error, /52 companies/, format);
    assert.match(body.error, /CSV|narrow/i, format);
  }
  const csv = await exportCsv(s, { filter });
  assert.equal(csv.status, 413);
  assert.match((await csv.json()).error, /52 rows/);

  // One company under the limit works in every format
  const narrow = group("AND", rule("name", "startsWith", `${tag} 07`));
  for (const format of ["xlsx", "pdf", "docx"]) assert.equal((await exportDoc(s, { format, filter: narrow })).status, 200, format);
});

test("permissions, narrowing rule and input validation", async () => {
  const tag = `BP${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} one` });
  const filter = group("AND", rule("name", "startsWith", tag));

  assert.equal((await exportDoc(null, { format: "xlsx", filter })).status, 401);

  const s = await sessionFor("USER");
  assert.equal((await exportDoc(s, { format: "xlsx", filter: group("AND") })).status, 403, "a plain user must add a filter first");
  assert.equal((await exportDoc(s, { format: "exe", filter })).status, 400);
  assert.equal((await exportDoc(s, { format: "xlsx" })).status, 403, "no filter at all is treated as an empty filter");
  assert.equal((await exportDoc(s, { format: "xlsx", filter: { kind: "nonsense" } })).status, 400, "an invalid filter is rejected");

  // Without the PDF/Word permission, only Excel (spreadsheet) works; without the CSV permission, Excel is refused too.
  const base = ["companies.view", "reports.create", "reports.viewOwn"];
  const docsOnly = await userWithPermissions([...base, "reports.exportDocs"]);
  assert.equal((await exportDoc(docsOnly, { format: "pdf", filter })).status, 200);
  assert.equal((await exportDoc(docsOnly, { format: "xlsx", filter })).status, 403);
  const csvOnly = await userWithPermissions([...base, "reports.exportCsv"]);
  assert.equal((await exportDoc(csvOnly, { format: "xlsx", filter })).status, 200);
  assert.equal((await exportDoc(csvOnly, { format: "docx", filter })).status, 403);
  assert.equal((await exportDoc(csvOnly, { format: "pdf", filter })).status, 403);
  const none = await userWithPermissions(base);
  for (const format of ["xlsx", "pdf", "docx"]) assert.equal((await exportDoc(none, { format, filter })).status, 403, format);

  // The saved-report endpoints are unchanged: a saved report still exports through its own route.
  const created = await api(s, "/api/reports", { body: { name: `Saved ${tag}`, filter, dailyRefresh: false } });
  assert.equal(created.status, 200, created.text);
  const saved = await fetch(`${BASE}/api/reports/${created.json.report.id}/export?format=docx`, { headers: { cookie: `director_session=${s.cookie}` } });
  assert.equal(saved.status, 200);
});

// ---- PDF and Word have no 5,000-company limit: every matching company is exported -------------------------------------

function pdfTextOf(pdf: Buffer): string | null {
  if (spawnSync("pdftotext", ["-v"]).error) return null; // an independent reader; skipped where Poppler is not installed
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-it-pdf-"));
  try {
    fs.writeFileSync(path.join(dir, "x.pdf"), pdf);
    const r = spawnSync("pdftotext", ["-layout", path.join(dir, "x.pdf"), "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    assert.equal(r.status, 0, `pdftotext: ${r.stderr}`);
    assert.equal(r.stderr, "", "the PDF reader reports no problems");
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function bulkCompanies(tag: string, n: number) {
  const data = Array.from({ length: n }, (_, i) => ({
    companyNumber: `${tag}${String(i).padStart(5, "0")}`.toUpperCase(), // unique per test: the tag is unique and the index is fixed-width
    name: `${tag} ${String(i).padStart(5, "0")}`,
    status: i % 7 === 0 ? "dissolved" : "active",
    type: "ltd",
    incorporationDate: new Date("2015-06-15T00:00:00Z"),
    registeredAddress1: "1 Test Street",
    registeredCity: "Testville",
    registeredPostcode: "TE1 1ST",
    source: "bulk_import",
  }));
  await db.company.createMany({ data });
  return data;
}

test("Word and PDF export EVERY matching company above 5,000 (no document row limit), in the requested order", async () => {
  const admin = await sessionFor("SUPER_ADMIN"); // the integration server caps USER at 50 and ADMIN at 500 rows; SUPER_ADMIN is not capped
  const tag = `BG${Date.now() % 100000}`;
  const created = await bulkCompanies(tag, 6200);
  const active = created.filter((c) => c.status === "active"); // every 7th is dissolved
  const filter = group("AND", rule("name", "startsWith", tag), rule("status", "equals", "active"));
  const before = await db.report.count({ where: { ownerId: admin.userId } });
  assert.ok(active.length > 5_000, `test set above the old limit (${active.length})`);

  // Word, descending: every company once, last name first.
  const w = await exportDoc(admin, { format: "docx", filter, columns: ["name", "companyNumber", "status"], sortField: "name", sortDir: "desc" });
  assert.equal(w.status, 200);
  const wbuf = Buffer.from(await w.arrayBuffer());
  const xml = await unzip(wbuf, "word/document.xml");
  const rows = [...xml.matchAll(/<w:tr>(.*?)<\/w:tr>/g)].map((m) => [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((c) => c[1]));
  assert.deepEqual(rows[0], ["Company", "Company No.", "Status"], "headings");
  const body = rows.slice(1);
  assert.equal(body.length, active.length, "every matching company is in the document");
  assert.equal(new Set(body.map((r) => r[1])).size, active.length, "none repeated");
  assert.deepEqual(body.map((r) => r[0]), active.map((c) => c.name).sort().reverse(), "descending by name, exactly the matching set");
  assert.ok(body.every((r) => r[2] === "Active"), "the filter was respected");
  assert.ok(xml.includes(`Matching companies: ${active.length.toLocaleString("en-GB")}`));
  assert.ok(xml.trimEnd().endsWith("</w:document>"));

  // PDF, ascending
  const p = await exportDoc(admin, { format: "pdf", filter, columns: ["name", "companyNumber", "status"], sortField: "name", sortDir: "asc" });
  assert.equal(p.status, 200);
  const pbuf = Buffer.from(await p.arrayBuffer());
  assert.equal(pbuf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pbuf.subarray(-16).toString().includes("%%EOF"));
  const text = pdfTextOf(pbuf);
  if (text) {
    const names = [...text.matchAll(new RegExp(`${tag} ([0-9]{5})`, "g"))].map((m) => `${tag} ${m[1]}`);
    assert.deepEqual(names, active.map((c) => c.name).sort(), "every company once, ascending");
    assert.ok(text.includes(`Matching companies: ${active.length.toLocaleString("en-GB")}`));
  }

  // A saved report downloads in full too (same implementation), and exporting saved nothing new.
  assert.equal(await db.report.count({ where: { ownerId: admin.userId } }), before);
  const saved = await api(admin, "/api/reports", { body: { name: `Big ${tag}`, filter, dailyRefresh: false, columns: ["name", "companyNumber"] } });
  assert.equal(saved.status, 200, saved.text);
  const sr = await fetch(`${BASE}/api/reports/${saved.json.report.id}/export?format=docx`, { headers: { cookie: `director_session=${admin.cookie}` } });
  assert.equal(sr.status, 200);
  const sxml = await unzip(Buffer.from(await sr.arrayBuffer()), "word/document.xml");
  assert.equal((sxml.match(/<w:tr[ >]/g) ?? []).length, active.length + 1);
});

test("PDF and Word still respect the role's export limit (policy), with a clear message and no partial file", async () => {
  const tag = `BC${Date.now() % 100000}`;
  await bulkCompanies(tag, 520);
  const filter = group("AND", rule("name", "startsWith", tag));
  const admin = await sessionFor("ADMIN"); // limit 500 on the integration server
  for (const format of ["pdf", "docx"]) {
    const r = await exportDoc(admin, { format, filter });
    assert.equal(r.status, 413, format);
    assert.match(r.headers.get("content-type") ?? "", /json/);
    const body = await r.json();
    assert.match(body.error, /520 companies/);
    assert.match(body.error, /export limit is 500/);
    assert.match(body.error, /narrow/i);
  }
  // narrowed under the limit it works
  const ok = await exportDoc(admin, { format: "docx", filter: group("AND", rule("name", "startsWith", `${tag} 001`)) });
  assert.equal(ok.status, 200);
  const sheet = await unzip(Buffer.from(await ok.arrayBuffer()), "word/document.xml");
  assert.equal((sheet.match(/<w:tr[ >]/g) ?? []).length, 101, "header + the 100 companies numbered 00100-00199");
});
