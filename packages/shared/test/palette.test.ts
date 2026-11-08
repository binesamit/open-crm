// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  colorHex,
  colorKeyFromHex,
  COLOR_KEYS,
  DEFAULT_STATUS_LABELS,
  DEFAULT_STATUS_LABELS_EN,
  deltaE2000,
  EARTHY_PALETTE_HEX,
  EMPTY_STATUS_COLOR,
  GROUP_AUTO_COLORS,
  GROUP_COLOR_KEYS,
  GROUP_COLORS,
  GROUP_PALETTE,
  groupColorFromHex,
  labelColorSchema,
  LEGACY_LABEL_HEX,
  nextGroupColor,
  nextLabelColor,
  normalizeLabelColor,
  paint,
  PALETTE,
  PALETTE_GROUPS,
  paletteGroupOf,
  PICKER_COLORS,
  PICKER_COLUMNS,
  RENAMED_COLOR_KEYS,
  RETIRED_GROUP_COLOR_KEYS,
  columnTypes,
  STATUS_COLORS,
  VIVID_COLORS,
} from '../src';
import { FOREIGN_PALETTE } from './foreign-palette';

/**
 * D-PAL: our own palette — 40 colours (16 vivid, 12 deep, 8 soft, 4 neutral), light and dark — and
 * nothing close to the palette other work-management tools ship (FOREIGN_PALETTE: every hex the audit found).
 */
const statusColumn = () => columnTypes.get('status')!;
const hexes = COLOR_KEYS.flatMap((k) => [
  { key: k, mode: 'light', hex: PALETTE[k].light },
  { key: k, mode: 'dark', hex: PALETTE[k].dark },
]);
/** "Very close": below this CIEDE2000 difference two colours read as the same one. */
const MIN_DELTA_E = 6;

describe('our palette', () => {
  it('has 40 colours in four families, each with a light and a dark #rrggbb', () => {
    expect(COLOR_KEYS).toHaveLength(40);
    expect(Object.fromEntries(Object.entries(PALETTE_GROUPS).map(([g, ks]) => [g, ks.length]))).toEqual({
      vivid: 16,
      deep: 12,
      soft: 8,
      neutral: 4,
    });
    expect(Object.values(PALETTE_GROUPS).flat().sort()).toEqual([...COLOR_KEYS].sort());
    expect(PALETTE_GROUPS.deep).toEqual([
      'rust',
      'amber_deep',
      'olive_deep',
      'moss',
      'emerald_deep',
      'teal_deep',
      'ocean',
      'midnight',
      'grape',
      'magenta_deep',
      'wine',
      'maroon',
    ]);
    expect(PALETTE_GROUPS.soft).toEqual(['rose', 'peach', 'apricot', 'sky_soft', 'iris', 'lilac', 'orchid', 'blush']);
    expect(PALETTE_GROUPS.neutral).toEqual(['taupe', 'stone', 'graphite', 'steel']);
    expect(paletteGroupOf('moss')).toBe('deep');
    expect(paletteGroupOf('forest')).toBe('vivid');
    // Automatic colours are the 16 vivid ones (index-based colours never move); a picker shows all 40, 5 rows of 8.
    expect(STATUS_COLORS).toEqual(VIVID_COLORS);
    expect(VIVID_COLORS).toEqual(COLOR_KEYS.slice(0, 16));
    expect(PICKER_COLORS).toHaveLength(40);
    expect(new Set(PICKER_COLORS).size).toBe(40);
    expect(PICKER_COLORS.length / PICKER_COLUMNS).toBe(5);
    expect(PICKER_COLORS.slice(0, 16)).toEqual(VIVID_COLORS);
    expect(GROUP_PALETTE).toHaveLength(12);
    expect(new Set(GROUP_PALETTE).size).toBe(12);
    for (const k of GROUP_PALETTE) expect(COLOR_KEYS).toContain(k);
    for (const h of hexes) expect(h.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('starts new groups with green and amber', () => {
    expect(GROUP_PALETTE.slice(0, 2)).toEqual(['forest', 'yellow']);
    expect(deltaE2000(PALETTE.yellow.dark, '#ffb020')).toBeLessThan(20);
  });

  it('is vivid: the same fill in dark mode, except the few lifted off the dark surface', () => {
    const lifted = VIVID_COLORS.filter((k) => PALETTE[k].light !== PALETTE[k].dark);
    expect(lifted.sort()).toEqual(['blue', 'navy', 'plum', 'purple', 'violet']);
    for (const k of lifted) expect(deltaE2000(PALETTE[k].light, PALETTE[k].dark), k).toBeLessThan(12);
  });

  it('keeps the approved hex of the 24 added colours in light mode; dark mode lifts only the deep / dark ones', () => {
    expect(Object.fromEntries(COLOR_KEYS.slice(16).map((k) => [k, PALETTE[k].light]))).toEqual({
      rust: '#8a2e0f',
      amber_deep: '#8a480f',
      olive_deep: '#8a610f',
      moss: '#388a0f',
      emerald_deep: '#138630',
      teal_deep: '#0f798a',
      ocean: '#0f618a',
      midnight: '#0e3c7c',
      grape: '#480f8a',
      magenta_deep: '#6b0f8a',
      wine: '#8a0f5d',
      maroon: '#8a0f0f',
      rose: '#e35f5f',
      peach: '#e27c5a',
      apricot: '#de8c45',
      sky_soft: '#64a6d8',
      iris: '#755fe3',
      lilac: '#aa74e7',
      orchid: '#c25fe3',
      blush: '#dc5bad',
      taupe: '#564d43',
      stone: '#7f7366',
      graphite: '#57616b',
      steel: '#7e8c9a',
    });
    // Dark mode: the deep / dark ones are lifted off the dark surfaces (3:1); iris moves a little, away from the
    // lifted indigo (navy's dark value) it would otherwise match there.
    const lifted = COLOR_KEYS.slice(16).filter((k) => PALETTE[k].light !== PALETTE[k].dark);
    for (const k of lifted) expect(['deep', 'neutral', 'iris'], k).toContain(k === 'iris' ? k : paletteGroupOf(k));
    expect(deltaE2000(PALETTE.iris.light, PALETTE.iris.dark)).toBeLessThan(6);
    for (const k of PALETTE_GROUPS.soft.filter((x) => x !== 'iris')) expect(PALETTE[k].dark, k).toBe(PALETTE[k].light);
  });

  it('new labels take an unused vivid colour first, then the others', () => {
    expect(nextLabelColor([])).toBe('forest');
    expect(nextLabelColor(['forest', 'yellow'])).toBe('crimson');
    expect(nextLabelColor(['#00c875'])).toBe('yellow'); // an old hex reads as its key
    expect(nextLabelColor(VIVID_COLORS)).toBe(PICKER_COLORS[16]);
    expect(nextLabelColor(COLOR_KEYS)).toBe(VIVID_COLORS[40 % 16]);
  });

  it('new groups take the 16 vivid colours first (the 12 group colours, then the other four), then the rest', () => {
    expect(GROUP_AUTO_COLORS).toHaveLength(40);
    expect(GROUP_AUTO_COLORS.slice(0, 12)).toEqual([...GROUP_PALETTE]);
    expect([...GROUP_AUTO_COLORS.slice(0, 16)].sort()).toEqual([...VIVID_COLORS].sort());
    expect(nextGroupColor([])).toBe('forest');
    expect(nextGroupColor(GROUP_PALETTE)).toBe('gold');
    expect(nextGroupColor(VIVID_COLORS)).toBe(GROUP_AUTO_COLORS[16]);
  });

  it('reads the renamed keys (olive, brown) as gold, as a label and as a group', () => {
    expect(RENAMED_COLOR_KEYS).toEqual({ brown: 'gold', olive: 'gold' });
    expect(labelColorSchema.parse('olive')).toBe('gold');
    expect(labelColorSchema.parse('brown')).toBe('gold');
    expect(paint('olive')).toBe('var(--c-gold)');
    expect(paint('brown')).toBe('var(--c-gold)');
    expect(GROUP_COLORS.brown).toBe(PALETTE.gold.light);
    expect(GROUP_COLORS.violet).toBe(PALETTE.violet.light);
    expect(colorHex('olive', 'dark')).toBe(PALETTE.gold.dark);
  });

  it(`no colour is within ΔE2000 ${MIN_DELTA_E} of the imported palette`, () => {
    const close = hexes.flatMap((h) =>
      FOREIGN_PALETTE.map((f) => ({ ...h, foreign: f, d: deltaE2000(h.hex, f) })).filter((x) => x.d < MIN_DELTA_E),
    );
    expect(close).toEqual([]);
  });

  it(`the colours are told apart from each other (ΔE2000 ≥ ${MIN_DELTA_E} in each mode; the vivid 16 ≥ 7)`, () => {
    for (const mode of ['light', 'dark'] as const)
      for (const [i, a] of COLOR_KEYS.entries())
        for (const b of COLOR_KEYS.slice(i + 1)) {
          const min = VIVID_COLORS.includes(a) && VIVID_COLORS.includes(b) ? 7 : MIN_DELTA_E;
          expect(deltaE2000(PALETTE[a][mode], PALETTE[b][mode]), `${a}/${b} ${mode}`).toBeGreaterThanOrEqual(min);
        }
  });

  it('measures ΔE2000 like the reference (Sharma et al. pairs)', () => {
    expect(deltaE2000('#000000', '#000000')).toBe(0);
    expect(deltaE2000('#ffffff', '#000000')).toBeCloseTo(100, 0);
    expect(deltaE2000('#ff0000', '#fe0000')).toBeLessThan(1);
  });
});

describe('group colours', () => {
  it('keeps every stored key (the enum) — retired keys render as their twin; every palette key is a group key', () => {
    expect(GROUP_COLOR_KEYS).toHaveLength(19 + 28);
    for (const k of COLOR_KEYS) expect(GROUP_COLOR_KEYS as readonly string[]).toContain(k);
    for (const k of COLOR_KEYS) expect(GROUP_COLORS[k], k).toBe(PALETTE[k].light);
    for (const k of GROUP_COLOR_KEYS) expect(GROUP_COLORS[k]).toMatch(/^#[0-9a-f]{6}$/);
    for (const [old, twin] of Object.entries(RETIRED_GROUP_COLOR_KEYS)) {
      expect(COLOR_KEYS).toContain(twin);
      expect(GROUP_COLORS[old as keyof typeof GROUP_COLORS]).toBe(PALETTE[twin].light);
      expect(paint(old)).toBe(`var(--c-${twin})`);
    }
    for (const k of GROUP_PALETTE) expect(GROUP_COLORS[k]).toBe(PALETTE[k].light);
  });

  it('a hex from an import becomes one of the 12 group colours', () => {
    expect(groupColorFromHex('#00c875')).toBe('forest');
    // olive reads as gold, a label colour only → the nearest of the 12 group colours
    expect(groupColorFromHex('#cab641')).toBe('green');
    for (const h of FOREIGN_PALETTE) expect(GROUP_PALETTE).toContain(groupColorFromHex(h));
  });
});

describe('label colours as keys', () => {
  it('every old hex maps to a key (the import / migration table); the default trio is ours', () => {
    for (const h of FOREIGN_PALETTE.filter((x) => x in LEGACY_LABEL_HEX))
      expect(COLOR_KEYS).toContain(colorKeyFromHex(h));
    // The table keeps the keys migration 0080 wrote; olive / brown are renamed keys and read as gold.
    expect(colorKeyFromHex('#cab641')).toBe('gold');
    expect(colorKeyFromHex('#7f5347')).toBe('gold');
    expect(colorKeyFromHex('#fdab3d')).toBe('yellow');
    expect(colorKeyFromHex('#00C875')).toBe('forest');
    expect(colorKeyFromHex('#df2f4a')).toBe('crimson');
    expect(colorKeyFromHex(PALETTE.sage.dark)).toBe('sage');
    expect(colorKeyFromHex('#08b04a')).toBe('forest'); // unknown → nearest
    // pal40: an added colour's own hex reads exactly; any other hex still lands on the nearest vivid colour.
    expect(colorKeyFromHex('#0e3c7c')).toBe('midnight');
    expect(colorKeyFromHex(PALETTE.grape.dark)).toBe('grape');
    expect(VIVID_COLORS).toContain(colorKeyFromHex('#0f3d7d'));
    // The earlier (earthy) palette's values read exactly as their key.
    for (const [h, k] of Object.entries(EARTHY_PALETTE_HEX)) expect(colorKeyFromHex(h)).toBe(k);
    expect(colorKeyFromHex('#2e6b57')).toBe('forest');
  });

  it('reads input and old data: a key stays, a group key / old hex becomes a key, anything else fails', () => {
    expect(labelColorSchema.parse('plum')).toBe('plum');
    expect(labelColorSchema.parse('#e2445c')).toBe('crimson');
    expect(labelColorSchema.parse('lime')).toBe('green');
    expect(labelColorSchema.parse('done_green')).toBe('green');
    expect(labelColorSchema.safeParse('nope').success).toBe(false);
    expect(normalizeLabelColor(3)).toBe(3);
    const parsed = statusColumn().settingsSchema.parse({
      labels: [{ id: 0, label: 'x', color: '#c4c4c4', index: 0 }],
    }) as { labels: { color: string }[] };
    expect(parsed.labels[0]!.color).toBe('gray');
  });

  it('paints a key, a retired / legacy group key or an old hex as a theme variable; empty as --status-empty', () => {
    expect(paint('forest')).toBe('var(--c-forest)');
    expect(paint('#fdab3d')).toBe('var(--c-yellow)');
    expect(paint('bright_blue')).toBe('var(--c-blue)');
    expect(paint(EMPTY_STATUS_COLOR)).toBe('var(--status-empty)');
    expect(paint('var(--primary)')).toBe('var(--primary)');
    expect(paint(null)).toBeUndefined();
    expect(paint(paint('navy'))).toBe('var(--c-navy)');
  });

  it('gives a real hex where one is needed (light / dark)', () => {
    expect(colorHex('crimson')).toBe(PALETTE.crimson.light);
    expect(colorHex('crimson', 'dark')).toBe(PALETTE.crimson.dark);
    expect(colorHex('#00c875')).toBe(PALETTE.forest.light);
    expect(colorHex('nope', 'light', null)).toBeNull();
  });

  it('new status columns start with in progress / done / blocked in our colours', () => {
    expect(DEFAULT_STATUS_LABELS.map((l) => [l.label, l.color, !!l.is_done])).toEqual([
      ['בתהליך', 'yellow', false],
      ['הושלם', 'forest', true],
      ['חסום', 'crimson', false],
    ]);
    expect(DEFAULT_STATUS_LABELS_EN.map((l) => l.label)).toEqual(['In progress', 'Done', 'Blocked']);
    for (const l of DEFAULT_STATUS_LABELS) expect(FOREIGN_PALETTE).not.toContain(colorHex(l.color));
  });
});
