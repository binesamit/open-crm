// SPDX-License-Identifier: AGPL-3.0-only
/** Colours, fonts and escaping shared by the email layouts (templates.ts) and the email "objects" (objects.ts). */

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/**
 * The palette (11-UI-DESIGN §9, F4 light / F3 dark): a calm off-white page, a white card with a hairline, the brand
 * ink for headings, a softer ink for the body and a muted grey-green for secondary text. The accent (a setting) is
 * used once — the button — plus the small monogram when the account has no logo.
 */
export const C = {
  page: '#f4f7f6',
  card: '#ffffff',
  line: '#e3ece9',
  heading: '#0d3b35',
  ink: '#13221f',
  body: '#33524b',
  muted: '#5d756f',
  soft: '#f1f6f4',
};
/** The same roles in dark mode (F3). */
export const D = {
  page: '#072420',
  card: '#0f2e29',
  line: '#1f453e',
  heading: '#f2f8f6',
  ink: '#e3efec',
  body: '#c9dcd7',
  muted: '#8fb0a8',
  soft: '#163a34',
};
/** Semantic colours of the objects (fixed, readable on white and on the dark card). */
export const S = {
  ok: '#1f8a5b',
  warn: '#d9822b',
  bad: '#c8323a',
  note: '#ffe98a',
  noteInk: '#3d3415',
  board: '#141617',
};
const DARK_TEXT = '#1e1f22';
const WHITE = '#ffffff';
/** Text on the accent (the button): white or a near-black ink, whichever reads better. */
export const onAccent = (accent: string) =>
  contrast(accent, WHITE) >= contrast(accent, DARK_TEXT) ? WHITE : DARK_TEXT;
/** Links on the white card: the accent when it reads (≥ 4.5:1), else the ink. */
export const linkColor = (accent: string) => (contrast(accent, WHITE) >= 4.5 ? accent : C.ink);
/** An accent too dark to see on the dark card (the default green is): dark mode turns it light, as the app does. */
export const fadesInDark = (accent: string) => contrast(accent, D.card) < 3;

/** `accent` mixed into `base` (0–1 of the accent): the tints of the objects, computed once (no color-mix in email). */
export const mix = (accent: string, base: string, amount: number) => {
  const ch = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  const out = [1, 3, 5].map((i) => Math.round(ch(accent, i) * amount + ch(base, i) * (1 - amount)));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/** Heebo (the product's display face) where installed, else each platform's own UI font. */
export const FONT = "Heebo,Rubik,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** The display face of the objects style where installed (emails load no web fonts: no external requests), else Heebo. */
export const DISPLAY = `Karantina,${FONT}`;
/** The newspaper face of the digest and the letterhead. */
export const SERIF = "'Frank Ruhl Libre','David Libre',Georgia,'Times New Roman',serif";
export const MONO = "'IBM Plex Mono',Consolas,'Courier New',monospace";
