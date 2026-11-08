// SPDX-License-Identifier: AGPL-3.0-only
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipStream } from '../src/lib/zip-stream';

/** The streamed ZIP writer: readable by standard tools, entries deflated or stored, cancellable. */
const collect = async (r: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

describe('zipStream', () => {
  it('writes deflated and stored entries, streams and buffers, that unzip as they went in', async () => {
    const big = Buffer.alloc(300_000, 'אבגד הוזח ');
    const zip = await collect(
      zipStream([
        { name: 'טקסט.txt', body: big },
        { name: 'photo.png', body: Readable.from([Buffer.from('raw'), Buffer.from(' bytes')]), store: true },
        { name: 'empty.txt', body: '' },
      ]),
    );
    const out = unzipSync(new Uint8Array(zip));
    expect(Object.keys(out)).toEqual(['טקסט.txt', 'photo.png', 'empty.txt']);
    expect(Buffer.from(out['טקסט.txt']!).equals(big)).toBe(true);
    expect(Buffer.from(out['photo.png']!).toString()).toBe('raw bytes');
    expect(out['empty.txt']!.length).toBe(0);
    // The repeated text was packed; the stored entry was not.
    expect(zip.length).toBeLessThan(big.length / 10);
  });

  it('an empty archive is still a valid ZIP', async () => {
    expect(Object.keys(unzipSync(new Uint8Array(await collect(zipStream([])))))).toEqual([]);
  });

  it('a reader that stops early (a cancelled download) also stops reading the file', async () => {
    let closed = false;
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024, 1));
      },
      destroy(err, cb) {
        closed = true;
        cb(err);
      },
    });
    const zip = zipStream([{ name: 'endless.bin', body: source }]);
    let got = 0;
    for await (const chunk of zip) {
      got += (chunk as Buffer).length;
      if (got > 256 * 1024) break;
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
  });
});
