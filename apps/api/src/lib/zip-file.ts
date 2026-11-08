// SPDX-License-Identifier: AGPL-3.0-only
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';
import { crc32Update } from './xlsx';

/**
 * A ZIP written to a file entry by entry, without holding the archive in memory (the account
 * export): each entry streams through deflate (or is stored as is, for files that are compressed already) into the
 * file; its CRC and sizes are written back into its local header afterwards (the file is seekable, so no data
 * descriptors). ZIP64 records are added when the archive passes 4 GB or 65,535 entries; one entry stays below 4 GB.
 */
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

type Central = { name: Buffer; crc: number; packed: number; size: number; offset: number; method: number };

/** Types that are compressed already (images, video, audio, archives, office files) — stored, not deflated. */
export const isCompressedMime = (mime: string) =>
  /^(image\/(png|jpe?g|gif|webp|avif|heic)|video\/|audio\/|application\/(zip|gzip|x-7z-compressed|x-rar-compressed|pdf|vnd\.openxmlformats))/i.test(
    mime,
  );

/** A file / folder name that every unzip tool accepts (no separators, no reserved characters, not too long). */
export const safeName = (name: string, fallback: string) => {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return clean || fallback;
};

/** Unique names inside one folder: "a.pdf", "a (2).pdf", … */
export const uniqueIn = (used: Set<string>, name: string) => {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
};

export type ZipFile = {
  /** Adds one entry; `body` is the bytes or a stream of them. */
  add(name: string, body: Buffer | string | Readable, opts?: { store?: boolean }): Promise<void>;
  /** Writes the central directory and closes the file; returns the archive's size. */
  close(): Promise<number>;
  /** Closes without finishing (an error on the way). */
  abort(): Promise<void>;
  readonly entries: number;
};

export const createZipFile = async (path: string): Promise<ZipFile> => {
  const fh: FileHandle = await open(path, 'w');
  let offset = 0;
  const centrals: Central[] = [];
  const write = async (buf: Buffer, position?: number) => {
    await fh.write(buf, 0, buf.length, position ?? offset);
    if (position === undefined) offset += buf.length;
  };

  const add: ZipFile['add'] = async (name, body, opts = {}) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const method = opts.store ? 0 : 8;
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(nameBuf.length, 26);
    await write(Buffer.concat([local, nameBuf]));

    let crc = 0;
    let size = 0;
    let packed = 0;
    const source =
      body instanceof Readable ? body : Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]);
    async function* counted() {
      for await (const chunk of source as AsyncIterable<Buffer | string>) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32Update(crc, buf);
        size += buf.length;
        yield buf;
      }
    }
    async function sink(src: AsyncIterable<Buffer>) {
      for await (const chunk of src) {
        packed += chunk.length;
        await write(chunk);
      }
    }
    if (method === 8) await pipeline(counted, createDeflateRaw(), sink);
    else await pipeline(counted, sink);
    if (size > MAX32 || packed > MAX32) throw new Error('zip_entry_too_large');
    // Back-fill the CRC and sizes.
    const fix = Buffer.alloc(12);
    fix.writeUInt32LE(crc >>> 0, 0);
    fix.writeUInt32LE(packed, 4);
    fix.writeUInt32LE(size, 8);
    await write(fix, start + 14);
    centrals.push({ name: nameBuf, crc: crc >>> 0, packed, size, offset: start, method });
  };

  const close = async () => {
    const dirStart = offset;
    for (const c of centrals) {
      const big = c.offset > MAX32;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(c.offset), 4);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(big ? 45 : 20, 4);
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.packed, 20);
      h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(big ? MAX32 : c.offset, 42);
      await write(Buffer.concat([h, c.name, extra]));
    }
    const dirSize = offset - dirStart;
    const zip64 = centrals.length > MAX16 || dirStart > MAX32 || dirSize > MAX32;
    if (zip64) {
      const recStart = offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeBigUInt64LE(BigInt(centrals.length), 24);
      rec.writeBigUInt64LE(BigInt(centrals.length), 32);
      rec.writeBigUInt64LE(BigInt(dirSize), 40);
      rec.writeBigUInt64LE(BigInt(dirStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(recStart), 8);
      loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(centrals.length, MAX16), 8);
    end.writeUInt16LE(Math.min(centrals.length, MAX16), 10);
    end.writeUInt32LE(Math.min(dirSize, MAX32), 12);
    end.writeUInt32LE(Math.min(dirStart, MAX32), 16);
    await write(end);
    await fh.close();
    return offset;
  };

  return {
    add,
    close,
    abort: () => fh.close().catch(() => undefined),
    get entries() {
      return centrals.length;
    },
  };
};
