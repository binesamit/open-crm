// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLOR_KEYS, paintLabel, PALETTE, paletteVars } from '@bines/shared';
import { CONTRAST_PAIRS, contrastRatio, PALETTES, paletteCss, type Tokens } from '@bines/ui';

/**
 * Round 12: every colour theme passes WCAG AA in light AND dark — the token pairs the app draws text and controls
 * with, over the real base values in tokens.css (the page-level audit of each theme is e2e/r12-ui.spec.ts).
 */
const css = readFileSync(new URL('../../../../packages/ui/src/tokens.css', import.meta.url), 'utf8');
const blockOf = (selector: string): Tokens => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} in tokens.css`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const out: Tokens = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
};
const baseLight = blockOf(':root');
const baseDark = { ...baseLight, ...blockOf("[data-theme='dark']") };
const baseSidebar = blockOf("[data-theme='light'] [data-sidebar='light']");

const check = (tokens: Tokens, pairs = CONTRAST_PAIRS) =>
  pairs
    .map((p) => {
      const ratio = contrastRatio(tokens[p.fg]!, tokens[p.bg]!, p.under ? tokens[p.under] : undefined);
      return { pair: `${p.fg} on ${p.bg}`, ratio: Math.round(ratio * 100) / 100, min: p.min };
    })
    .filter((r) => !(r.ratio >= r.min));

describe('colour themes (palettes)', () => {
  it('has the default and several more, each named', () => {
    expect(PALETTES[0]!.id).toBe('f4');
    expect(PALETTES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
  });

  for (const p of PALETTES) {
    it(`${p.id}: dark overrides every token light does (no light value leaks into dark mode)`, () => {
      expect(Object.keys(p.light).filter((k) => !(k in p.dark))).toEqual([]);
    });
    it(`${p.id}: light passes AA`, () => {
      expect(check({ ...baseLight, ...p.light })).toEqual([]);
    });
    it(`${p.id}: dark passes AA`, () => {
      expect(check({ ...baseDark, ...p.dark })).toEqual([]);
    });
    it(`${p.id}: the light sidebar passes AA`, () => {
      const shell = CONTRAST_PAIRS.filter((x) => x.bg === '--shell' && x.fg !== '--focus-ring');
      expect(check({ ...baseLight, ...p.light, ...baseSidebar, ...p.sidebarLight }, shell)).toEqual([]);
    });
  }

  it('generates light, dark (chosen and system) and light-sidebar rules', () => {
    const out = paletteCss();
    expect(out).toContain(":root[data-palette='ocean']{--shell:#0b2e4f;");
    expect(out).toContain(":root[data-palette='ocean'][data-theme='dark']{");
    expect(out).toContain("@media (prefers-color-scheme: dark){:root[data-palette='ocean']:not([data-theme='light'])");
    expect(out).toContain(":root[data-palette='ocean'][data-theme='light'] [data-sidebar='light']{");
    expect(out).not.toContain("data-palette='f4'"); // the default changes nothing
  });

  // D-PAL (vivid): our label / group palette in every theme. A status is a full fill with white bold text (--on-c):
  // at least 2.6:1 on every fill — the accepted trade-off of the classic work-management look (bold 14px text).
  // A fill (a status, a bar, a battery segment) stands off the surface: 3:1 on the dark surface (WCAG 1.4.11); on a
  // light surface the pair is the same as white text on the fill, so the same 2.6:1. tokens.css carries the palette
  // as --c-<key>, equal to colors.ts.
  const ON_FILL_MIN = 2.6;
  it('tokens.css carries the palette (--c-<key>) exactly as colors.ts, light and dark', () => {
    expect(paletteVars('light')).toEqual(
      Object.fromEntries(Object.keys(paletteVars('light')).map((k) => [k, baseLight[k]])),
    );
    expect(paletteVars('dark')).toEqual(
      Object.fromEntries(Object.keys(paletteVars('dark')).map((k) => [k, baseDark[k]])),
    );
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    for (const [k, v] of Object.entries(paletteVars('dark'))) expect(media).toContain(`${k}: ${v};`);
  });
  for (const p of PALETTES)
    for (const mode of ['light', 'dark'] as const) {
      it(`${p.id} ${mode}: every label colour stands off the surface and carries white bold text`, () => {
        const tokens = mode === 'light' ? { ...baseLight, ...p.light } : { ...baseDark, ...p.dark };
        const surface = tokens['--surface']!;
        expect(tokens['--on-c']).toBe('#ffffff');
        const bad: string[] = [];
        for (const k of COLOR_KEYS) {
          const c = PALETTE[k][mode];
          if (contrastRatio(c, surface) < (mode === 'dark' ? 3 : ON_FILL_MIN)) bad.push(`${k} on surface`);
          if (contrastRatio(tokens['--on-c']!, c) < ON_FILL_MIN) bad.push(`${k} --on-c`);
        }
        expect(bad).toEqual([]);
      });
    }

  // Prod ("ג2"): a label chip / status cell is a strong tint of its colour with the text in a deep shade
  // readable text (WCAG AA, 4.5:1) for every palette colour, light and dark, as tokens.css draws it.
  for (const mode of ['light', 'dark'] as const)
    it(`${mode}: every label chip (--c-<key>-soft / -ink) reads at 4.5:1`, () => {
      const tokens = mode === 'light' ? baseLight : baseDark;
      const bad = COLOR_KEYS.map((k) => ({
        k,
        ratio: contrastRatio(tokens[`--c-${k}-ink`]!, tokens[`--c-${k}-soft`]!),
      })).filter((x) => !(x.ratio >= 4.5));
      expect(bad).toEqual([]);
    });

  it('paints a label chip from its key; the empty status stays grey; a non-key has no chip colours', () => {
    expect(paintLabel('crimson')).toEqual({ soft: 'var(--c-crimson-soft)', ink: 'var(--c-crimson-ink)' });
    expect(paintLabel('empty')).toEqual({ soft: 'var(--status-empty)', ink: 'var(--fg)' });
    expect(paintLabel(null)).toBeUndefined();
  });

  it('measures contrast like WCAG (black on white = 21, translucent laid over its base)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000', 'rgba(0, 0, 0, 0)', '#ffffff')).toBeCloseTo(21, 0);
  });
});
