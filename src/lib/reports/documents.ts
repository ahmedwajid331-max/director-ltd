import { Readable } from "node:stream";
import yauzl from "yauzl";
import PDFDocument from "pdfkit";
import { AlignmentType, Document, Footer, HeadingLevel, PageOrientation, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { zipStream } from "./zipStream";

// Builders for the report PDF / Word downloads. They take the already-resolved table (headings + rows, exactly the cells
// the CSV export produces) so every format shows the same data.
//
// Both are STREAMING: rows arrive in batches and the file is written as it is produced, so memory stays flat whatever the
// number of companies (no row ceiling is needed for memory's sake). buildPdf / buildDocx collect a stream into a Buffer for
// callers that want the whole file at once.

export interface ReportDocMeta {
  title: string;
  description?: string | null;
  generatedAt: Date;
  total: number;
  // One-line, human-readable description of the saved conditions.
  conditions?: string;
  sortLabel?: string;
}

export type Cell = string | number;
// Rows in batches, in the order they must appear. A plain array of batches or an async generator both work.
export type RowBatches = Iterable<Cell[][]> | AsyncIterable<Cell[][]>;

const fmt = (d: Date) => d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

function metaLines(m: ReportDocMeta): string[] {
  return [
    ...(m.description ? [m.description] : []),
    `Matching companies: ${m.total.toLocaleString("en-GB")}`,
    ...(m.conditions ? [`Conditions: ${m.conditions}`] : []),
    ...(m.sortLabel ? [`Sorted by: ${m.sortLabel}`] : []),
    `Generated: ${fmt(m.generatedAt)}`,
  ];
}

// The standard PDF fonts are Latin-1 only: map common typographic characters, replace anything else.
export function pdfSafe(value: Cell): string {
  return String(value)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

// XML 1.0 cannot contain most control characters.
export function xmlSafe(value: Cell): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}

async function* asBatches(b: RowBatches): AsyncGenerator<Cell[][]> {
  for await (const batch of b as AsyncIterable<Cell[][]>) yield batch;
}

async function collect(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

// ---- PDF -----------------------------------------------------------------------------------------------------------
// pdfkit writes each page out as soon as it is complete (pages are NOT buffered), so a 100,000-company PDF costs the same
// memory as a 10-company one. The footer therefore reads "Page n" (the total page count is not known until the end); the
// total number of companies is in the header block.
export function pdfStream(meta: ReportDocMeta, headers: string[], batches: RowBatches): Readable {
  const margin = 30;
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin, info: { Title: pdfSafe(meta.title), Producer: "DIRECTOR.LTD" } });

  // Never let the document run far ahead of a slow reader: wait while a couple of MB are already waiting to be read.
  const relieve = async () => {
    while (!doc.destroyed && doc.readableLength > 2_000_000) await new Promise((r) => setTimeout(r, 5));
    if (doc.destroyed) throw new Error("The download was cancelled.");
    await new Promise((r) => setImmediate(r));
  };

  const run = async () => {
    const iterator = asBatches(batches)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstRows: Cell[][] = first.done ? [] : first.value;

    const width = doc.page.width - margin * 2;
    const fontSize = headers.length <= 8 ? 8 : headers.length <= 12 ? 7 : 6;
    // Column widths follow content length (header or the longest of the first rows, capped) so short columns stay narrow.
    const sample = firstRows.slice(0, 300);
    const weights = headers.map((h, i) => Math.max(6, Math.min(34, Math.max(h.length, ...sample.map((r) => String(r[i] ?? "").length)))));
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / sum) * width);
    const pad = 3;
    const maxLines = 3;
    let pageNo = 1;

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f172a").text(pdfSafe(meta.title), margin, margin, { width });
    doc.font("Helvetica").fontSize(9).fillColor("#475569");
    for (const line of metaLines(meta)) doc.text(pdfSafe(line), margin, doc.y, { width });
    doc.moveDown(0.6);

    const limit = () => doc.page.height - margin - 16;
    const footer = () => {
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // writing in the footer band must not trigger a new page
      doc.font("Helvetica").fontSize(7).fillColor("#94a3b8");
      doc.text(`DIRECTOR.LTD  |  ${pdfSafe(meta.title)}  |  Page ${pageNo}`, margin, doc.page.height - margin + 4, { width, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottom;
    };
    const cellText = (v: Cell, w: number) => {
      const max = Math.max(4, Math.floor(((w - pad * 2) / (fontSize * 0.5)) * maxLines) - 1);
      const t = pdfSafe(v);
      return t.length > max ? t.slice(0, max - 1) + "~" : t;
    };
    const drawRow = (cells: Cell[], opts: { header?: boolean; shade?: boolean }) => {
      doc.font(opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      const texts = cells.map((c, i) => cellText(c, widths[i]));
      const h = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: widths[i] - pad * 2 }))) + pad * 2;
      if (doc.y + h > limit()) {
        footer();
        doc.addPage();
        pageNo++;
        doc.x = margin;
        doc.y = margin;
        drawRow(headers, { header: true });
      }
      const y = doc.y;
      let x = margin;
      if (opts.header || opts.shade) doc.save().rect(margin, y, width, h).fill(opts.header ? "#e0e7ff" : "#f8fafc").restore();
      doc.font(opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor(opts.header ? "#312e81" : "#0f172a");
      texts.forEach((t, i) => {
        doc.text(t, x + pad, y + pad, { width: widths[i] - pad * 2, lineBreak: true });
        x += widths[i];
      });
      doc.save().moveTo(margin, y + h).lineTo(margin + width, y + h).lineWidth(0.4).strokeColor("#e2e8f0").stroke().restore();
      doc.x = margin;
      doc.y = y + h;
    };

    drawRow(headers, { header: true });
    let n = 0;
    let rowsDrawn = 0;
    let batch: Cell[][] | undefined = firstRows;
    while (batch) {
      for (const r of batch) {
        drawRow(r, { shade: n % 2 === 1 });
        n++;
        rowsDrawn++;
      }
      await relieve();
      const next = await iterator.next();
      batch = next.done ? undefined : next.value;
    }
    if (rowsDrawn === 0) doc.moveDown().font("Helvetica-Oblique").fontSize(9).fillColor("#64748b").text("No companies match this report.", margin, doc.y);
    footer();
    doc.end();
  };

  run().catch((err) => doc.destroy(err instanceof Error ? err : new Error(String(err))));
  return doc as unknown as Readable;
}

export function buildPdf(meta: ReportDocMeta, headers: string[], rows: Cell[][]): Promise<Buffer> {
  return collect(pdfStream(meta, headers, [rows]));
}

// ---- Word ----------------------------------------------------------------------------------------------------------
// The document is laid out ONCE by the docx library with a single placeholder body row (so the package parts, styles,
// header row, table grid and footer are exactly what the library produces). The body rows are then written straight into
// word/document.xml from that row's markup, batch by batch, inside a streaming ZIP - no per-row objects are ever held.
const TOKEN = (i: number) => `@@C${i}@@`;
const escXml = (v: Cell) => xmlSafe(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          stream.on("data", (d) => parts.push(d));
          stream.on("end", () => {
            out.set(e.fileName, Buffer.concat(parts));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

async function docxScaffold(meta: ReportDocMeta, headers: string[]): Promise<Map<string, Buffer>> {
  const size = headers.length <= 8 ? 16 : headers.length <= 12 ? 14 : 12; // half-points
  const cell = (text: Cell, header = false) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: xmlSafe(text), bold: header, size })] })],
      shading: header ? { fill: "E0E7FF" } : undefined,
      margins: { top: 40, bottom: 40, left: 70, right: 70 },
    });
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h) => cell(h, true)) }),
      new TableRow({ cantSplit: true, children: headers.map((_, i) => cell(TOKEN(i))) }),
    ],
  });
  const doc = new Document({
    creator: "DIRECTOR.LTD",
    title: xmlSafe(meta.title),
    sections: [
      {
        properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "DIRECTOR.LTD  |  Page ", size: 14 }), new TextRun({ children: [PageNumber.CURRENT], size: 14 })] })],
          }),
        },
        children: [
          new Paragraph({ text: xmlSafe(meta.title), heading: HeadingLevel.HEADING_1 }),
          ...metaLines(meta).map((l) => new Paragraph({ children: [new TextRun({ text: xmlSafe(l), size: 18, color: "475569" })] })),
          new Paragraph({ text: "" }),
          table,
        ],
      },
    ],
  });
  return readZip(await Packer.toBuffer(doc));
}

export async function* docxStream(meta: ReportDocMeta, headers: string[], batches: RowBatches): AsyncGenerator<Buffer> {
  const parts = await docxScaffold(meta, headers);
  const docXml = parts.get("word/document.xml")?.toString("utf8");
  if (!docXml) throw new Error("Could not prepare the Word document.");

  // The placeholder body row: from the <w:tr> that holds the first token to its closing tag.
  const at = docXml.indexOf(TOKEN(0));
  // "<w:tr>" / "<w:tr " only: a plain "<w:tr" would also match the row's own "<w:trPr>" child.
  const rowStart = Math.max(docXml.lastIndexOf("<w:tr>", at), docXml.lastIndexOf("<w:tr ", at));
  const rowEnd = docXml.indexOf("</w:tr>", at) + "</w:tr>".length;
  if (at < 0 || rowStart < 0 || rowEnd < "</w:tr>".length) throw new Error("Could not prepare the Word document table.");
  const template = docXml.slice(rowStart, rowEnd);
  const pieces = template.split(/@@C(\d+)@@/); // [text, index, text, index, ..., text]
  const rowXml = (cells: Cell[]) => {
    let s = pieces[0];
    for (let i = 1; i < pieces.length; i += 2) s += escXml(cells[Number(pieces[i])] ?? "") + pieces[i + 1];
    return s;
  };
  const head = docXml.slice(0, rowStart);
  const tail = docXml.slice(rowEnd);
  const empty = head + tail.replace("</w:tbl>", `</w:tbl><w:p><w:r><w:rPr><w:i/></w:rPr><w:t>No companies match this report.</w:t></w:r></w:p>`);

  async function* documentXml(): AsyncGenerator<string> {
    const iterator = asBatches(batches)[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done && next.value.length === 0) next = await iterator.next();
    if (next.done) {
      yield empty;
      return;
    }
    yield head;
    while (!next.done) {
      let chunk = "";
      for (const r of next.value) chunk += rowXml(r);
      yield chunk;
      next = await iterator.next();
    }
    yield tail;
  }

  yield* zipStream([...parts].map(([name, data]) => ({ name, data: name === "word/document.xml" ? documentXml() : data })));
}

export function buildDocx(meta: ReportDocMeta, headers: string[], rows: Cell[][]): Promise<Buffer> {
  return collect(docxStream(meta, headers, [rows]));
}

// "Report-name-2026-10-10.pdf" style file names: ASCII, no path characters, dated.
export function reportFileName(title: string, ext: "pdf" | "docx" | "xlsx", now = new Date()): string {
  const slug = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "") || "report";
  return `${slug}-${now.toISOString().slice(0, 10)}.${ext}`;
}
