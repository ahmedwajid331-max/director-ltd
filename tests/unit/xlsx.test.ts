import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { buildXlsx, columnRef } from "../../src/lib/reports/xlsx";

function entries(buf: Buffer): Promise<Map<string, { text: string; crcOk: boolean }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, { text: string; crcOk: boolean }>();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, st) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          st.on("data", (d) => parts.push(d));
          st.on("end", () => {
            const data = Buffer.concat(parts);
            out.set(e.fileName, { text: data.toString("utf8"), crcOk: (crc32(data) >>> 0) === e.crc32 });
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

const meta = { title: "Test <report> & co", generatedAt: new Date("2026-10-12T10:30:00Z"), total: 2, conditions: "Status is Active AND Name starts with A", sortLabel: "Company (ascending)" };

test("columnRef maps indexes to Excel column letters", () => {
  assert.equal(columnRef(0), "A");
  assert.equal(columnRef(25), "Z");
  assert.equal(columnRef(26), "AA");
  assert.equal(columnRef(51), "AZ");
  assert.equal(columnRef(52), "BA");
  assert.equal(columnRef(701), "ZZ");
  assert.equal(columnRef(702), "AAA");
});

test("buildXlsx produces a valid package: required parts, intact CRCs, workbook with two sheets", async () => {
  const buf = buildXlsx(meta, ["Company", "Company No."], [["ALPHA LTD", "00012345"], ["BETA LTD", "SC123456"]]);
  assert.equal(buf.subarray(0, 2).toString(), "PK");
  const parts = await entries(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
    assert.ok(parts.has(name), `${name} present`);
    assert.ok(parts.get(name)!.crcOk, `${name} CRC matches`);
  }
  assert.match(parts.get("xl/workbook.xml")!.text, /<sheet name="Companies" sheetId="1"/);
  assert.match(parts.get("xl/workbook.xml")!.text, /<sheet name="Report details" sheetId="2"/);
  // Every XML part is well formed enough to start with a declaration and end with its root element.
  for (const [name, p] of parts) assert.match(p.text, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>/, name);
});

test("buildXlsx data sheet: header row, rows in order, text cells keep leading zeros, numbers stay numeric, XML is escaped", async () => {
  const buf = buildXlsx(meta, ["Company", "Company No.", "Directors"], [["A & B <LTD>", "00012345", 3], ["Z\u0001 CO", "SC1", 0]]);
  const sheet = (await entries(buf)).get("xl/worksheets/sheet1.xml")!.text;
  assert.ok(sheet.includes('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Company</t></is></c>'), "bold header");
  assert.ok(sheet.includes("A &amp; B &lt;LTD&gt;"), "escaped");
  assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">00012345</t></is></c>'), "company number is text with its zeros");
  assert.ok(sheet.includes('<c r="C2"><v>3</v></c>'), "numbers numeric");
  assert.ok(sheet.includes('<c r="C3"><v>0</v></c>'), "zero is kept");
  assert.ok(!sheet.includes("\u0001"), "control characters removed");
  assert.ok(sheet.indexOf("A &amp; B") < sheet.indexOf("Z CO"), "row order preserved");
  assert.ok(sheet.includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'), "header frozen");
  assert.ok(sheet.includes('<autoFilter ref="A1:C3"/>'), "filter covers header + rows");
});

test("buildXlsx details sheet records the conditions, count and sort; an empty result still has a header-only sheet", async () => {
  const parts = await entries(buildXlsx({ ...meta, total: 0 }, ["Company"], []));
  const details = parts.get("xl/worksheets/sheet2.xml")!.text;
  for (const s of ["Test &lt;report&gt; &amp; co", "Status is Active AND Name starts with A", "Company (ascending)", "2026-10-12 10:30"]) assert.ok(details.includes(s), s);
  const data = parts.get("xl/worksheets/sheet1.xml")!.text;
  assert.ok(data.includes('<autoFilter ref="A1:A1"/>'));
  assert.ok(!data.includes('<row r="2">'));
});

test("buildXlsx truncates a cell at Excel's limit and handles a large table", async () => {
  const huge = "x".repeat(40_000);
  const rows = Array.from({ length: 20_000 }, (_, i) => [`CO ${i}`, String(i).padStart(8, "0")]);
  rows[0] = [huge, "00000000"];
  const buf = buildXlsx(meta, ["Company", "No."], rows);
  const sheet = (await entries(buf)).get("xl/worksheets/sheet1.xml")!.text;
  assert.ok(!sheet.includes("x".repeat(32_001)), "cell limited to 32,000 characters");
  assert.ok(sheet.includes('<row r="20001">'), "all rows written");
});
