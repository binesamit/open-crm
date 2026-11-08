// SPDX-License-Identifier: AGPL-3.0-only
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeImage, imagePixels, MAX_IMAGE_PIXELS } from '../src/modules/pwa/icons';

/** Audit 2026-10-10 #6: a logo's declared size is read from its header; a decompression bomb is never decoded. */
const png = (w: number, h: number) => {
  const img = new PNG({ width: w, height: h });
  img.data.fill(255);
  return PNG.sync.write(img);
};

describe('logo pixels (decompression bomb)', () => {
  it('reads PNG and JPEG sizes from the header', () => {
    expect(imagePixels(png(12, 10))).toBe(120);
    const j = jpeg.encode({ width: 8, height: 6, data: Buffer.alloc(8 * 6 * 4, 200) }, 80).data;
    expect(imagePixels(j)).toBe(48);
    expect(imagePixels(Buffer.from('GIF89a......'))).toBeNull();
  });

  it('decodes a normal logo; refuses one declaring a huge image without decoding it', () => {
    expect(decodeImage(png(12, 10))).toMatchObject({ w: 12, h: 10 });
    const bomb = png(4, 4);
    bomb.writeUInt32BE(30_000, 16); // IHDR width
    bomb.writeUInt32BE(30_000, 20); // IHDR height
    expect(imagePixels(bomb)).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(decodeImage(bomb)).toBeNull();
  });
});
