import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

// Opens the monthly Companies House file as a stream of CSV bytes, whatever
// shape it arrives in:
//   - a .zip (what Companies House publishes) -> the .csv entry is
//     streamed out of the archive; nothing is ever fully loaded into memory
//   - a plain .csv
//   - an https URL of either -> downloaded to a local cache file first
//     (resumable with HTTP Range), so the exact same bytes can be re-read on
//     resume, and a fingerprint (name|size|mtime) proves it is the same file.

export interface CsvSource {
  stream: Readable;
  fingerprint: string;
  name: string;
  close: () => void;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export async function isZipFile(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.equals(ZIP_MAGIC);
  } finally {
    await fh.close();
  }
}

export function fingerprintFile(file: string): string {
  const st = fs.statSync(file);
  return `${path.basename(file)}|${st.size}|${Math.round(st.mtimeMs)}`;
}

function openZipEntry(file: string): Promise<{ stream: Readable; entryName: string; zip: yauzl.ZipFile }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Could not open zip"));
      let csvCount = 0;
      zip.on("error", reject);
      zip.on("end", () => {
        if (csvCount === 0) reject(new Error("The zip archive does not contain a .csv file"));
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!/\.csv$/i.test(entry.fileName) || /\/$/.test(entry.fileName)) return zip.readEntry();
        csvCount++;
        // Guard against zip bombs / wrong file: the real file is ~2-3 GB.
        const MAX = 20 * 1024 ** 3;
        if (entry.uncompressedSize > MAX) {
          zip.close();
          return reject(new Error(`CSV entry is implausibly large (${entry.uncompressedSize} bytes)`));
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("Could not read zip entry"));
          resolve({ stream, entryName: entry.fileName, zip });
        });
      });
      zip.readEntry();
    });
  });
}

export async function openCsvFile(file: string): Promise<CsvSource> {
  if (!fs.existsSync(file)) throw new Error(`Input file not found: ${file}`);
  const fingerprint = fingerprintFile(file);
  if (await isZipFile(file)) {
    const { stream, entryName, zip } = await openZipEntry(file);
    return { stream, fingerprint, name: `${path.basename(file)}!${entryName}`, close: () => zip.close() };
  }
  const stream = fs.createReadStream(file);
  return { stream, fingerprint, name: path.basename(file), close: () => stream.destroy() };
}

// Downloads a URL into `dir`, resuming a partial file if one exists and the
// server supports Range. Returns the local path.
export async function downloadToCache(url: string, dir: string, onLog: (m: string) => void = () => {}): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "download.bin");
  const dest = path.join(dir, fileName);
  const part = dest + ".part";

  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`Download failed: HTTP ${head.status} for ${url}`);
  const total = Number(head.headers.get("content-length") ?? 0);

  if (fs.existsSync(dest) && total > 0 && fs.statSync(dest).size === total) {
    onLog(`Using cached download ${dest}`);
    return dest;
  }

  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, have > 0 ? { headers: { Range: `bytes=${have}-` } } : {});
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const resuming = have > 0 && res.status === 206;
  onLog(`Downloading ${url} (${total ? Math.round(total / 1e6) + " MB" : "unknown size"})${resuming ? ` resuming at ${have}` : ""}`);
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(part, { flags: resuming ? "a" : "w" }));

  if (total > 0 && fs.statSync(part).size !== total) {
    throw new Error("Download incomplete (size mismatch); re-run to resume");
  }
  fs.renameSync(part, dest);
  return dest;
}

// Monthly file URL. Companies House publishes on/around the 1st; if the
// current month's file is not up yet, fall back to the previous month.
export function monthlyFileUrl(year: number, month1: number): string {
  return `https://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-${year}-${String(month1).padStart(2, "0")}-01.zip`;
}

export async function resolveLatestMonthlyUrl(now: Date = new Date()): Promise<string> {
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const url = monthlyFileUrl(d.getUTCFullYear(), d.getUTCMonth() + 1);
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) return url;
  }
  throw new Error("No monthly Companies House bulk file found for the last 3 months");
}
