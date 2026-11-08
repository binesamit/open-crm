// SPDX-License-Identifier: AGPL-3.0-only
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { type PwaIcon, pwaIconSize } from '@bines/shared';

/**
 * Home-screen icons (PWA פ1), drawn on the server in pure JS (no native image library — D2 / Windows App Control):
 * the account's logo (PNG or JPEG) fitted on a white tile, or — no logo, or a format we cannot read — a neutral
 * mark (three bars, like a board) in white on the account's / platform's colour.
 */

type Rgba = { w: number; h: number; data: Uint8Array };

const hex = (color: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  const n = parseInt(m?.[1] ?? '0d3b35', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};

/** The most pixels a logo may have (≈ 4000×4000): a small file may declare a huge image (audit 2026-10-10 #6). */
export const MAX_IMAGE_PIXELS = 16_000_000;

/**
 * The pixel count a PNG (IHDR) or JPEG (its SOF frame) declares, read from the header without decoding; null when
 * the format is not one of those or the header is broken.
 */
export const imagePixels = (bytes: Buffer): number | null => {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47)
    return bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC): height, then width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return bytes.readUInt16BE(i + 5) * bytes.readUInt16BE(i + 7);
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
};

/** Decodes a PNG or JPEG (by its magic bytes); null for anything else (GIF, WebP, AVIF …) or a broken file. */
export const decodeImage = (bytes: Buffer): Rgba | null => {
  try {
    // Never decode what declares more pixels than a logo may have (decompression bomb, audit 2026-10-10 #6).
    const pixels = imagePixels(bytes);
    if (pixels === null || pixels > MAX_IMAGE_PIXELS) return null;
    if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47) {
      const png = PNG.sync.read(bytes);
      return { w: png.width, h: png.height, data: new Uint8Array(png.data) };
    }
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
      return { w: img.width, h: img.height, data: img.data };
    }
  } catch {
    return null;
  }
  return null;
};

/** Area-average resample (premultiplied alpha, so transparent edges do not darken). */
export const resize = (src: Rgba, w: number, h: number): Rgba => {
  const out = new Uint8Array(w * h * 4);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = Math.max(y0 + 1e-6, (y + 1) * sy);
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = Math.max(x0 + 1e-6, (x + 1) * sx);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let yy = Math.floor(y0); yy < Math.min(src.h, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(src.w, Math.ceil(x1)); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const k = (yy * src.w + xx) * 4;
          const wt = wx * wy;
          const al = src.data[k + 3]! / 255;
          r += src.data[k]! * al * wt;
          g += src.data[k + 1]! * al * wt;
          b += src.data[k + 2]! * al * wt;
          a += al * wt;
          weight += wt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (weight || 1)) * 255);
    }
  }
  return { w, h, data: out };
};

const canvas = (size: number, rgb: readonly [number, number, number]): Rgba => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { w: size, h: size, data };
};

/** Draws `img` over `base` at (left, top), alpha-blended. */
const blit = (base: Rgba, img: Rgba, left: number, top: number) => {
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const bx = left + x;
      const by = top + y;
      if (bx < 0 || by < 0 || bx >= base.w || by >= base.h) continue;
      const s = (y * img.w + x) * 4;
      const d = (by * base.w + bx) * 4;
      const a = img.data[s + 3]! / 255;
      for (let c = 0; c < 3; c++) base.data[d + c] = Math.round(img.data[s + c]! * a + base.data[d + c]! * (1 - a));
    }
  }
};

/**
 * How much of the tile the logo / mark may use: maskable icons keep to the 80% safe circle (with margin); the tab's
 * icon is tiny, so the logo / mark fills more of it.
 */
const innerShare = (icon: PwaIcon) =>
  icon.startsWith('maskable') ? 0.6 : icon.startsWith('apple') ? 0.76 : icon.startsWith('favicon') ? 0.9 : 0.82;

const encode = (img: Rgba) => {
  const png = new PNG({ width: img.w, height: img.h });
  png.data = Buffer.from(img.data);
  return PNG.sync.write(png);
};

/** The account's logo on a white tile, centred and fitted. */
export const logoIcon = (logo: Rgba, icon: PwaIcon) => {
  const size = pwaIconSize(icon);
  const box = Math.round(size * innerShare(icon));
  const scale = Math.min(box / logo.w, box / logo.h);
  const w = Math.max(1, Math.round(logo.w * scale));
  const h = Math.max(1, Math.round(logo.h * scale));
  const base = canvas(size, [255, 255, 255]);
  blit(base, resize(logo, w, h), Math.round((size - w) / 2), Math.round((size - h) / 2));
  return encode(base);
};

/** Inside a rounded rectangle? (coverage 0–1, 4×4 supersampled for smooth edges). */
const roundRectCoverage = (px: number, py: number, x: number, y: number, w: number, h: number, r: number) => {
  let hit = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const sx = px + (i + 0.5) / 4;
      const sy = py + (j + 0.5) / 4;
      if (sx < x || sx > x + w || sy < y || sy > y + h) continue;
      const cx = Math.min(Math.max(sx, x + r), x + w - r);
      const cy = Math.min(Math.max(sy, y + r), y + h - r);
      if ((sx - cx) ** 2 + (sy - cy) ** 2 <= r * r) hit++;
    }
  }
  return hit / 16;
};

/** No logo: three white bars (a board) on the brand colour. */
export const defaultIcon = (color: string, icon: PwaIcon) => {
  const size = pwaIconSize(icon);
  const base = canvas(size, hex(color));
  const inner = size * innerShare(icon);
  const left = (size - inner) / 2 + inner * 0.12;
  const bar = inner * 0.16;
  const gap = inner * 0.1;
  const top = (size - (bar * 3 + gap * 2)) / 2;
  const widths = [0.76, 0.56, 0.66].map((f) => inner * f);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      widths.forEach((w, i) => {
        cover = Math.max(cover, roundRectCoverage(x, y, left, top + i * (bar + gap), w, bar, bar / 2));
      });
      if (!cover) continue;
      const d = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) base.data[d + c] = Math.round(255 * cover + base.data[d + c]! * (1 - cover));
    }
  }
  return encode(base);
};

/** A small LRU of rendered icons (an icon costs tens of ms; installs and manifests ask often). */
const cache = new Map<string, Buffer>();
const CACHE_SIZE = 200;
export const cachedIcon = (key: string, render: () => Buffer) => {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const png = render();
  cache.set(key, png);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return png;
};
