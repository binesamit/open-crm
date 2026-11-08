// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * The look of interactive documents (product owner: "default background and text colours for documents seen by
 * guests and by members, and per document too"). Layers, each value empty = the layer below:
 *   built-in look  <  the account's default for the audience (guests / members)  <  the template / document's own.
 * Only colours and a font family — the page's structure never changes. Contrast is checked (WCAG AA 4.5:1) and shown
 * as a warning where the theme is edited; the page itself never refuses a theme.
 */

export const IDOC_FONTS = ['default', 'display', 'serif'] as const;
export type IdocFont = (typeof IDOC_FONTS)[number];

const color = z
  .string()
  .max(9)
  .regex(/^(#[0-9a-fA-F]{6})?$/, 'a #RRGGBB colour or empty')
  .default('');

export const idocThemeSchema = z.object({
  /** Around the page (the frame behind the paper). */
  background: color,
  /** The page itself. */
  paper: color,
  text: color,
  /** Secondary text (labels, notes); empty = a mix of the text and the paper. */
  muted: color,
  /** Buttons, ticks, links, highlights. */
  accent: color,
  /** The title band at the top; empty = the accent's dark, else the platform's. */
  header: color,
  font: z.enum(IDOC_FONTS).default('default'),
});
export type IdocTheme = z.infer<typeof idocThemeSchema>;

export const IDOC_AUDIENCES = ['guests', 'members'] as const;
export type IdocAudience = (typeof IDOC_AUDIENCES)[number];

/** The account's defaults (Administration → General → documents): one for guests, one for the account's members. */
export const idocAccountThemesSchema = z.object({
  guests: idocThemeSchema.default(() => idocThemeSchema.parse({})),
  members: idocThemeSchema.default(() => idocThemeSchema.parse({})),
});
export type IdocAccountThemes = z.infer<typeof idocAccountThemesSchema>;

export const emptyIdocTheme = (): IdocTheme => idocThemeSchema.parse({});

/** Later layers win where they set a value. */
export const mergeIdocThemes = (...layers: (Partial<IdocTheme> | null | undefined)[]): IdocTheme => {
  const out = emptyIdocTheme();
  for (const l of layers) {
    if (!l) continue;
    for (const k of Object.keys(out) as (keyof IdocTheme)[]) {
      const v = l[k];
      if (k === 'font') {
        if (v && v !== 'default') out.font = v as IdocFont;
      } else if (typeof v === 'string' && v) (out as Record<string, string>)[k] = v;
    }
  }
  return out;
};

// ——— contrast (WCAG 2.x) ———

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (hex: string): number | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** Contrast ratio of two #RRGGBB colours (1–21), or null when one is not a colour. */
export const contrastRatio = (a: string, b: string): number | null => {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** Dark or white ink, whichever reads better on a colour. */
export const idocInkOn = (hex: string, dark = '#13221f') => {
  const l = luminance(hex);
  if (l === null) return '#ffffff';
  return (contrastRatio(hex, '#ffffff') ?? 0) >= (contrastRatio(hex, dark) ?? 0) ? '#ffffff' : dark;
};

export const IDOC_MIN_CONTRAST = 4.5;

/** The pairs of a theme that read below WCAG AA (4.5:1). Only pairs where both colours are set are checked. */
export const idocThemeWarnings = (t: IdocTheme): { pair: 'text' | 'muted' | 'accent' | 'header'; ratio: number }[] => {
  const out: { pair: 'text' | 'muted' | 'accent' | 'header'; ratio: number }[] = [];
  const check = (pair: 'text' | 'muted' | 'accent' | 'header', a: string, b: string) => {
    const r = a && b ? contrastRatio(a, b) : null;
    if (r !== null && r < IDOC_MIN_CONTRAST) out.push({ pair, ratio: Math.round(r * 100) / 100 });
  };
  check('text', t.text, t.paper);
  check('muted', t.muted, t.paper);
  // Links and ticks drawn in the accent on the paper (large text / UI parts need 3:1; the stricter 4.5 is kept).
  check('accent', t.accent, t.paper);
  return out;
};
