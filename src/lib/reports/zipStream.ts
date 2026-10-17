import { crc32, createDeflateRaw, deflateRawSync } from "node:zlib";
import { Readable, pipeline } from "node:stream";

// Streaming ZIP writer (no dependency). Small parts are compressed in one go; a large part (a Word document's body) is
// given as an async iterable and compressed AS IT IS PRODUCED, so memory stays flat however many rows it holds. A streamed
// entry uses the ZIP "data descriptor": its CRC and sizes are written after the data, and repeated in the central
// directory, which is how every streaming ZIP writer works and what Word / Excel / unzip all read.
// Limits: classic ZIP (no ZIP64), so a single part must stay below 4 GB - an error is raised rather than writing a bad file.

export interface ZipEntry {
  name: string;
  data: Buffer | AsyncIterable<string | Buffer>;
}

const DOS_TIME_DATE = 0x00210000; // fixed 1980-01-01: reproducible output
const MAX_ZIP32 = 0xffff_fff0;

async function* tap(source: AsyncIterable<string | Buffer>, stats: { crc: number; size: number }): AsyncGenerator<Buffer> {
  for await (const piece of source) {
    const buf = typeof piece === "string" ? Buffer.from(piece, "utf8") : piece;
    if (buf.length === 0) continue;
    stats.crc = crc32(buf, stats.crc) >>> 0;
    stats.size += buf.length;
    if (stats.size > MAX_ZIP32) throw new Error("A part of the file is too large for a ZIP archive (4 GB).");
    yield buf;
  }
}

export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(DOS_TIME_DATE, 10);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10); // deflate
    c.writeUInt32LE(DOS_TIME_DATE, 12);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);

    let crc: number;
    let csize: number;
    let usize: number;
    let written = local.length + name.length;

    if (Buffer.isBuffer(e.data)) {
      const deflated = deflateRawSync(e.data);
      crc = crc32(e.data) >>> 0;
      csize = deflated.length;
      usize = e.data.length;
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(csize, 18);
      local.writeUInt32LE(usize, 22);
      c.writeUInt16LE(0x0800, 8);
      yield local;
      yield name;
      yield deflated;
      written += csize;
    } else {
      local.writeUInt16LE(0x0808, 6); // UTF-8 names + data descriptor follows
      local.writeUInt16LE(8, 8);
      c.writeUInt16LE(0x0808, 8);
      yield local;
      yield name;
      const stats = { crc: 0, size: 0 };
      csize = 0;
      // pipeline() propagates a failure of the row source into the deflater, so the error reaches the consumer of this
      // generator (and the download is aborted) instead of ending as a seemingly complete file.
      const compressed = pipeline(Readable.from(tap(e.data, stats)), createDeflateRaw(), () => undefined);
      for await (const chunk of compressed as AsyncIterable<Buffer>) {
        csize += chunk.length;
        if (csize > MAX_ZIP32) throw new Error("A part of the file is too large for a ZIP archive (4 GB).");
        yield chunk;
      }
      crc = stats.crc;
      usize = stats.size;
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
      yield desc;
      written += csize + desc.length;
    }

    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(usize, 24);
    central.push(c, name);
    offset += written;
    if (offset > MAX_ZIP32) throw new Error("The file is too large for a ZIP archive (4 GB).");
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  yield centralBuf;
  yield end;
}
