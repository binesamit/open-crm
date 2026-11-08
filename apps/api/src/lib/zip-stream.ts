// SPDX-License-Identifier: AGPL-3.0-only
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';
import { crc32Update } from './xlsx';

/**
 * A ZIP written straight into a response, entry by entry, never held in memory ("download all")
 * nothing can be written back, so each entry's CRC and sizes follow its data in a data descriptor (flag bit 3), and
 * names are marked UTF-8 (flag bit 11 — Hebrew names open correctly everywhere). Entries that are compressed
 * already are stored, the rest deflated. No ZIP64: the callers cap the archive well below 4 GB and 65,535 entries.
 */
const MAX32 = 0xffffffff;
const FLAGS = 0x0808; // bit 3: data descriptor, bit 11: UTF-8 names

export type ZipEntry = { name: string; body: Readable | Buffer | string; store?: boolean; date?: Date };

/** MS-DOS date and time (local clock, 2-second steps) — what unzip tools show as the file's date. */
const dosTime = (d: Date) => {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
};

type Central = {
  name: Buffer;
  crc: number;
  packed: number;
  size: number;
  offset: number;
  method: number;
  time: number;
  date: number;
};

async function* zipChunks(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Buffer> {
  let offset = 0;
  const centrals: Central[] = [];
  for await (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.store ? 0 : 8;
    const { time, date } = dosTime(e.date ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    const start = offset;
    yield Buffer.concat([local, name]);
    offset += 30 + name.length;

    let crc = 0;
    let size = 0;
    let packed = 0;
    const source = e.body instanceof Readable ? e.body : Readable.from([Buffer.from(e.body)]);
    async function* counted() {
      for await (const chunk of source as AsyncIterable<Buffer | string>) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32Update(crc, buf);
        size += buf.length;
        yield buf;
      }
    }
    if (method === 8) {
      const deflate = createDeflateRaw();
      const fed = pipeline(counted, deflate);
      let done = false;
      try {
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          packed += chunk.length;
          yield chunk;
        }
        done = true;
      } finally {
        // The reader went away (a cancelled download): stop reading the file too.
        if (!done) deflate.destroy();
        await fed.catch(() => undefined);
      }
      await fed;
    } else {
      for await (const chunk of counted()) {
        packed += chunk.length;
        yield chunk;
      }
    }
    if (size > MAX32 || packed > MAX32 || offset + packed > MAX32) throw new Error('zip_too_large');
    offset += packed;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(packed, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += 16;
    centrals.push({ name, crc: crc >>> 0, packed, size, offset: start, method, time, date });
  }

  const dirStart = offset;
  for (const c of centrals) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(FLAGS, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.packed, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt32LE(c.offset, 42);
    yield Buffer.concat([h, c.name]);
    offset += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(offset - dirStart, 12);
  end.writeUInt32LE(dirStart, 16);
  yield end;
}

/** The archive as a stream: entries are read one after another, as the reader pulls (backpressure). */
export const zipStream = (entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): Readable =>
  Readable.from(zipChunks(entries), { objectMode: false });
