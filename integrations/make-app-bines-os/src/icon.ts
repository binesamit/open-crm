// SPDX-License-Identifier: MIT
import { crc32, deflateSync } from 'node:zlib';

/**
 * The app's icon for Make (`assets/icon.png`, uploaded by `scripts/push.ts` → `PUT /sdk/apps/{name}/{version}/icon`):
 * the Bines OS mark of the n8n nodes (`integrations/n8n-nodes-bines-os/nodes/BinesOs/binesOs.svg`) — the three
 * rounded bars — as a 512 × 512 PNG.
 *
 * Make recolours an app's logo with the app's theme (#5b5bd6): transparent / white areas show the theme colour, black
 * areas show white, semi-transparent black a blend of the two. So the bars are drawn black on a transparent canvas,
 * the same opacities as the SVG's white bars (one at 0.85): in Make it is the brand mark — white bars on #5b5bd6.
 */
export const ICON_SIZE = 512;
export const ICON_FILE = 'assets/icon.png';

/** The mark's bars in the SVG's 60 × 60 view box (the SVG's white `rect`s, its background square left out). */
export const MARK_BARS = [
  { x: 14, y: 14, width: 9, height: 32, rx: 4.5, opacity: 1 },
  { x: 26, y: 14, width: 20, height: 14, rx: 7, opacity: 0.85 },
  { x: 26, y: 32, width: 20, height: 14, rx: 7, opacity: 1 },
] as const;

/** View-box units → pixels: the bars (14 … 46) span 320 px, centred, with room for Make's round badge. */
const SCALE = 10;
const CENTRE = 30;
const SAMPLES = 4; // 4 × 4 samples per pixel: smooth edges.

const insideBar = (bar: (typeof MARK_BARS)[number], x: number, y: number) => {
  if (x < bar.x || x > bar.x + bar.width || y < bar.y || y > bar.y + bar.height) return false;
  const r = bar.rx;
  const cx = Math.min(Math.max(x, bar.x + r), bar.x + bar.width - r);
  const cy = Math.min(Math.max(y, bar.y + r), bar.y + bar.height - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** Alpha 0 … 1 of the mark at pixel (px, py). */
const coverage = (px: number, py: number) => {
  let sum = 0;
  for (let sy = 0; sy < SAMPLES; sy++)
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = CENTRE + (px + (sx + 0.5) / SAMPLES - ICON_SIZE / 2) / SCALE;
      const y = CENTRE + (py + (sy + 0.5) / SAMPLES - ICON_SIZE / 2) / SCALE;
      const bar = MARK_BARS.find((b) => insideBar(b, x, y));
      if (bar) sum += bar.opacity;
    }
  return sum / (SAMPLES * SAMPLES);
};

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** The icon as PNG bytes (RGBA, deterministic: the committed file is checked against it). */
export const renderIcon = (): Buffer => {
  const row = 1 + ICON_SIZE * 4;
  const raw = Buffer.alloc(row * ICON_SIZE);
  for (let y = 0; y < ICON_SIZE; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < ICON_SIZE; x++) {
      const a = Math.round(coverage(x, y) * 255);
      raw[y * row + 1 + x * 4 + 3] = a; // black (0, 0, 0) with this alpha
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(ICON_SIZE, 0);
  header.writeUInt32BE(ICON_SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
