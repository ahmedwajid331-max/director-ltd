import { test } from "node:test";
import assert from "node:assert/strict";
import yauzl from "yauzl";
import { buildDocx, buildPdf, pdfSafe, reportFileName, xmlSafe } from "../../src/lib/reports/documents";

const meta = { title: "Dormant & Active – Q4", description: "Test", generatedAt: new Date("2026-10-10T09:00:00Z"), total: 120, conditions: "Dormant is yes", sortLabel: "Company (ascending)" };
const headers = ["Company", "Company No.", "Status"];
const rows = Array.from({ length: 120 }, (_, i) => [`ACME LTD ${i + 1}`, String(10000000 + i), i % 2 ? "Active" : "Dormant"]);

function unzip(buf: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, string>();
      zip.readEntry();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          stream.on("data", (d) => parts.push(d));
          stream.on("end", () => {
            out.set(e.fileName, Buffer.concat(parts).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
    });
  });
}

test("PDF is a valid, multi-page document", async () => {
  const pdf = await buildPdf(meta, headers, rows);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.subarray(-16).toString().includes("%%EOF"));
  const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 2, `expected several pages for 120 rows, got ${pages}`);
});

test("PDF with no rows and unusual characters still builds", async () => {
  const pdf = await buildPdf({ ...meta, total: 0 }, headers, [["Ünïcode 株式会社 “q”", "1", "x\u0000y"]]);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await buildPdf({ ...meta, total: 0 }, headers, [])).subarray(0, 5).toString(), "%PDF-");
});

test("DOCX is a genuine OOXML package containing the title, metadata, headings and every row", async () => {
  const docx = await buildDocx(meta, headers, rows);
  assert.equal(docx.subarray(0, 2).toString(), "PK");
  const files = await unzip(docx);
  assert.ok(files.has("[Content_Types].xml") && files.has("word/document.xml") && files.has("_rels/.rels"));
  const xml = files.get("word/document.xml")!;
  assert.ok(xml.includes("Dormant &amp; Active") && xml.includes("Matching companies: 120"));
  for (const h of headers) assert.ok(xml.includes(`>${h}<`), `heading ${h}`);
  assert.ok(xml.includes("ACME LTD 1<") && xml.includes("ACME LTD 120<"), "first and last rows present");
  assert.equal((xml.match(/<w:tr[ >]/g) ?? []).length, 121, "header row + 120 data rows");
  assert.ok(xml.includes("w:tblHeader"), "header row repeats across pages");
});

test("text sanitisers and file names", () => {
  assert.equal(pdfSafe("A–B ‘x’ 株"), "A-B 'x' ?");
  assert.equal(xmlSafe("a\u0000b\u000Bc"), "abc");
  assert.equal(reportFileName("Testing2", "pdf", new Date("2026-10-10T00:00:00Z")), "Testing2-2026-10-10.pdf");
  assert.equal(reportFileName('../../etc/"passwd" ??', "docx", new Date("2026-10-10T00:00:00Z")), "etcpasswd-2026-10-10.docx");
  assert.equal(reportFileName("株式会社", "pdf", new Date("2026-10-10T00:00:00Z")), "report-2026-10-10.pdf");
});
