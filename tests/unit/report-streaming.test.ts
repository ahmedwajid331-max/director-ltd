import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { docxStream, pdfStream, type Cell } from "../../src/lib/reports/documents";
import { zipStream } from "../../src/lib/reports/zipStream";

const meta = { title: "Big & <export>", description: "Streaming test", generatedAt: new Date("2026-10-12T09:00:00Z"), total: 0, conditions: "Name starts with ROW", sortLabel: "Company (ascending)" };
const headers = ["Company", "Company No.", "Status"];

// `n` rows in batches of 1000, produced lazily (nothing holds them all).
async function* batches(n: number, per = 1000): AsyncGenerator<Cell[][]> {
  for (let i = 0; i < n; i += per) {
    const batch: Cell[][] = [];
    for (let j = i; j < Math.min(n, i + per); j++) batch.push([`ROW ${String(j).padStart(6, "0")} & CO`, String(10_000_000 + j), j % 2 ? "Active" : "Dormant"]);
    yield batch;
  }
}

async function collect(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

function entries(buf: Buffer): Promise<Map<string, { data: Buffer; crcOk: boolean; sizeOk: boolean }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, { data: Buffer; crcOk: boolean; sizeOk: boolean }>();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, st) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          st.on("error", reject);
          st.on("data", (d) => parts.push(d));
          st.on("end", () => {
            const data = Buffer.concat(parts);
            out.set(e.fileName, { data, crcOk: (crc32(data) >>> 0) === e.crc32, sizeOk: data.length === e.uncompressedSize });
            zip.readEntry();
          });
        });
      });
      zip.on("error", reject);
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

// An INDEPENDENT reader (Poppler's pdftotext) extracts the text of every page. Skipped checks when it is not installed.
const POPPLER = spawnSync("pdftotext", ["-v"], { encoding: "utf8" }).error ? null : "pdftotext";
function pdfText(pdf: Buffer): { text: string; errors: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-pdf-"));
  try {
    const file = path.join(dir, "x.pdf");
    fs.writeFileSync(file, pdf);
    const r = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return { text: r.stdout ?? "", errors: (r.stderr ?? "") + (r.status === 0 ? "" : `exit ${r.status}`) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("zipStream: stored and streamed entries make a valid ZIP (CRCs and sizes verified by an independent reader)", async () => {
  async function* body() {
    for (let i = 0; i < 300; i++) yield `line ${i} ${"x".repeat(200)}\n`;
  }
  const zip = await collect(zipStream([{ name: "a.txt", data: Buffer.from("hello") }, { name: "dir/big.txt", data: body() }, { name: "b.txt", data: Buffer.alloc(0) }]));
  const parts = await entries(zip);
  assert.deepEqual([...parts.keys()], ["a.txt", "dir/big.txt", "b.txt"]);
  for (const [name, p] of parts) assert.ok(p.crcOk && p.sizeOk, `${name} intact`);
  assert.equal(parts.get("a.txt")!.data.toString(), "hello");
  assert.ok(parts.get("dir/big.txt")!.data.toString().startsWith("line 0 ") && parts.get("dir/big.txt")!.data.toString().includes("line 299 "));
});

test("zipStream: a failing source aborts the stream - the file never looks complete", async () => {
  async function* bad() {
    yield "some data";
    throw new Error("database went away");
  }
  await assert.rejects(collect(zipStream([{ name: "x.xml", data: bad() }])), /database went away/);
});

test("Word: 12,000 rows streamed - every row present once, in order, valid package, no row limit", async () => {
  const docx = await collect(docxStream({ ...meta, total: 12_000 }, headers, batches(12_000)));
  assert.equal(docx.subarray(0, 2).toString(), "PK");
  const parts = await entries(docx);
  for (const [name, p] of parts) assert.ok(p.crcOk && p.sizeOk, `${name} intact`);
  for (const must of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/footer1.xml"]) assert.ok(parts.has(must), must);
  const xml = parts.get("word/document.xml")!.data.toString("utf8");
  assert.equal((xml.match(/<w:tr[ >]/g) ?? []).length, 12_001, "header + 12,000 rows");
  assert.equal((xml.match(/<\/w:tr>/g) ?? []).length, 12_001, "balanced rows");
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 1);
  assert.equal((xml.match(/<\/w:tbl>/g) ?? []).length, 1);
  assert.ok(xml.includes("Matching companies: 12,000") && xml.includes("Big &amp; &lt;export&gt;"));
  const names = [...xml.matchAll(/ROW (\d{6}) &amp; CO/g)].map((m) => Number(m[1]));
  assert.equal(names.length, 12_000);
  assert.ok(names.every((n, i) => n === i), "rows in the order given, none missing or repeated");
  assert.ok(xml.includes("w:tblHeader"));
  assert.ok(xml.trimEnd().endsWith("</w:document>"), "document closes properly");
});

test("Word: no rows gives a header-only table and a message", async () => {
  const xml = (await entries(await collect(docxStream({ ...meta, total: 0 }, headers, batches(0))))).get("word/document.xml")!.data.toString("utf8");
  assert.equal((xml.match(/<w:tr[ >]/g) ?? []).length, 1);
  assert.ok(xml.includes("No companies match this report."));
  assert.ok(xml.trimEnd().endsWith("</w:document>"));
});

test("PDF: 12,000 rows streamed - every row drawn once, in order, valid file, no row limit", async () => {
  const pdf = await collect(pdfStream({ ...meta, total: 12_000 }, headers, batches(12_000)));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.subarray(-16).toString().includes("%%EOF"));
  const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages > 150, `many pages, got ${pages}`);
  if (!POPPLER) return; // structural checks above still ran
  const { text, errors } = pdfText(pdf);
  assert.equal(errors, "", "an independent PDF reader reports no problems");
  const names = [...text.matchAll(/ROW (\d{6}) & CO/g)].map((m) => Number(m[1]));
  assert.equal(names.length, 12_000, "every company drawn exactly once");
  assert.ok(names.every((n, i) => n === i), "in order");
  assert.ok(text.includes(`Page ${pages}`), "last page numbered");
  assert.ok(text.includes("Matching companies: 12,000"));
});

test("PDF: a failure part-way destroys the stream (the download is aborted, not truncated silently)", async () => {
  async function* failing(): AsyncGenerator<Cell[][]> {
    yield (await batches(1000).next()).value as Cell[][];
    throw new Error("rows could not be read");
  }
  await assert.rejects(collect(pdfStream({ ...meta, total: 5000 }, headers, failing())), /rows could not be read/);
});

test("Word and PDF stay flat in memory for a very large export (200,000 rows streamed to a counting sink)", async () => {
  const sink = async (stream: AsyncIterable<Buffer | Uint8Array>) => {
    let bytes = 0;
    let peak = 0;
    const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 20);
    const base = process.memoryUsage().heapUsed;
    for await (const c of stream) bytes += c.length;
    clearInterval(t);
    return { bytes, growthMb: Math.max(0, peak - base) / 1_048_576 };
  };
  global.gc?.();
  const docx = await sink(docxStream({ ...meta, total: 200_000 }, headers, batches(200_000)));
  assert.ok(docx.bytes > 1_000_000, `real output (${docx.bytes} bytes)`);
  assert.ok(docx.growthMb < 150, `Word heap growth ${docx.growthMb.toFixed(0)} MB`);
  const pdf = await sink(pdfStream({ ...meta, total: 200_000 }, headers, batches(200_000)));
  assert.ok(pdf.bytes > 1_000_000, `real output (${pdf.bytes} bytes)`);
  assert.ok(pdf.growthMb < 150, `PDF heap growth ${pdf.growthMb.toFixed(0)} MB`);
});
