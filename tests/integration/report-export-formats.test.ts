import { test, after } from "node:test";
import assert from "node:assert/strict";
import yauzl from "yauzl";
import { api, BASE, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

const get = (s: Session | null, path: string) =>
  fetch(`${BASE}${path}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });

function unzipDoc(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on("entry", (e) => {
        if (e.fileName !== "word/document.xml") return zip.readEntry();
        zip.openReadStream(e, (err2, st) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          st.on("data", (d) => parts.push(d));
          st.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        });
      });
      zip.on("end", () => reject(new Error("no word/document.xml")));
    });
  });
}

test("PDF / Word report export: formats, saved filter + sort, permissions, ceiling", async () => {
  const owner = await sessionFor("USER");
  const other = await sessionFor("USER");
  const admin = await sessionFor("ADMIN");
  const tag = `RX${Date.now() % 1000000}`;
  for (const n of ["B", "A", "C"]) await makeCompany({ name: `${tag} ${n}`, status: "active" });
  await makeCompany({ name: `${tag} Z dissolved`, status: "dissolved" });

  const created = await api(owner, "/api/reports", {
    body: { name: `Export ${tag}`, filter: group("AND", rule("name", "startsWith", tag), rule("status", "equals", "active")), dailyRefresh: false, columns: ["name", "companyNumber", "status"] },
  });
  assert.equal(created.status, 200, created.text);
  const id = created.json.report.id as string;

  // Word: genuine package, only the report's matching rows, in the requested order, with the saved columns.
  const w = await get(owner, `/api/reports/${id}/export?format=docx&sortField=name&sortDir=desc`);
  assert.equal(w.status, 200);
  assert.equal(w.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(w.headers.get("content-disposition") ?? "", /filename="Export-RX\d+-\d{4}-\d{2}-\d{2}\.docx"/);
  const xml = await unzipDoc(Buffer.from(await w.arrayBuffer()));
  assert.ok(xml.includes("Matching companies: 3"));
  assert.ok(!xml.includes("dissolved"), "filter respected");
  for (const h of ["Company", "Company No.", "Status"]) assert.ok(xml.includes(`>${h}<`));
  assert.ok(!xml.includes(">Type<"), "saved column set respected");
  const order = ["C", "B", "A"].map((n) => xml.indexOf(`${tag} ${n}<`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "sort order respected (desc)");

  // PDF
  const p = await get(owner, `/api/reports/${id}/export?format=pdf`);
  assert.equal(p.status, 200);
  assert.equal(p.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

  // Permissions and input validation
  assert.equal((await get(null, `/api/reports/${id}/export?format=pdf`)).status, 401);
  assert.equal((await get(other, `/api/reports/${id}/export?format=pdf`)).status, 404, "another plain user cannot export it");
  assert.equal((await get(admin, `/api/reports/${id}/export?format=pdf`)).status, 200, "admins can");
  assert.equal((await get(owner, `/api/reports/${id}/export?format=exe`)).status, 400);
  assert.equal((await get(owner, `/api/reports/does-not-exist/export?format=pdf`)).status, 404);

  // Export is audited
  assert.ok((await db.activityLog.count({ where: { userId: owner.userId, action: { in: ["export_pdf", "export_docx"] } } })) >= 2);
});

test("PDF / Word export refuses (413) above the row ceiling instead of truncating; CSV route unaffected", async () => {
  const s = await sessionFor("USER");
  const tag = `RC${Date.now() % 1000000}`;
  // The integration server caps a USER export at 50 rows.
  for (let i = 0; i < 52; i++) await makeCompany({ name: `${tag} ${String(i).padStart(2, "0")}` });
  const created = await api(s, "/api/reports", { body: { name: `Big ${tag}`, filter: group("AND", rule("name", "startsWith", tag)), dailyRefresh: false } });
  assert.equal(created.status, 200, created.text);
  const res = await get(s, `/api/reports/${created.json.report.id}/export?format=docx`);
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /52 companies/);
  assert.match(body.error, /export limit of|your export limit/i);
  assert.match(body.error, /narrow/i);
});
