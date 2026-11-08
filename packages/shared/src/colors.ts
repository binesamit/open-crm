// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Our colour palette (11-UI-DESIGN §9.1, D-PAL, D30; forty colours since "pal40"): sixteen vivid
 * saturated colours, then twelve deep, eight soft and four neutral ones (`PALETTE_GROUPS`), each with a light-mode and
 * a dark-mode value. Stored data never holds a hex: a status label, a conditional-colouring rule, a group and a tag store
 * a KEY, and the hex is looked up here (render through `paint()` on the web, so dark mode follows; `colorHex()` where
 * a real colour is needed — exports, charts drawn on a server). A key's hex may change without moving any data.
 *
 * A status label ("ג2") is a STRONG TINT of its colour (`labelSoft`) with its text in a deep shade of
 *   it (`labelInk`), regular weight: every chip reads at 4.5:1 in light and dark (tested:
 *   apps/web/src/lib/palettes.test.ts). The vivid colour itself (`--on-c` white on it, at least 2.6:1) stays for bars,
 *   batteries, group marks and swatches. Dark mode keeps the same vivid value; only the colours that would sink into
 *   the dark surface (under 3:1) are lifted a little.
 * - None is within ΔE2000 6 of a colour of the palette other work-management tools ship, nor of another of ours in
 *   the same mode (tested: packages/shared/test/palette.test.ts), and the keys are ours.
 * - New labels and groups take the sixteen vivid colours first (`VIVID_COLORS`, `nextLabelColor`, `nextGroupColor`);
 *   a colour picker offers all forty (`PICKER_COLORS`).
 *
 * The CSS custom properties `--c-<key>` in packages/ui/src/tokens.css carry the same values (tested to match).
 */
export const PALETTE = {
  forest: { light: '#05b347', dark: '#05b347' },
  yellow: { light: '#f58000', dark: '#f58000' },
  crimson: { light: '#ff1a35', dark: '#ff1a35' },
  turquoise: { light: '#00a5e0', dark: '#00a5e0' },
  navy: { light: '#4040e8', dark: '#7464d4' },
  purple: { light: '#8a3ffc', dark: '#824fff' },
  green: { light: '#6eaa0e', dark: '#6eaa0e' },
  orange: { light: '#eb4600', dark: '#eb4600' },
  blue: { light: '#1a5cf0', dark: '#4268f4' },
  pink: { light: '#e5309a', dark: '#e5309a' },
  gold: { light: '#db8b00', dark: '#db8b00' },
  gray: { light: '#7b8db0', dark: '#7b8db0' },
  violet: { light: '#a000d6', dark: '#bc1cea' },
  sage: { light: '#05b382', dark: '#05b382' },
  slate: { light: '#00abc2', dark: '#00abc2' },
  plum: { light: '#c2006a', dark: '#d23476' },
  // Deep: dark tones. In dark mode the ones that would sink into the dark surfaces are lifted to 3:1.
  rust: { light: '#8a2e0f', dark: '#b45a32' },
  amber_deep: { light: '#8a480f', dark: '#a5642d' },
  olive_deep: { light: '#8a610f', dark: '#9b690f' },
  moss: { light: '#388a0f', dark: '#388a0f' },
  emerald_deep: { light: '#138630', dark: '#138630' },
  teal_deep: { light: '#0f798a', dark: '#287d8c' },
  ocean: { light: '#0f618a', dark: '#4b7896' },
  midnight: { light: '#0e3c7c', dark: '#556ec3' },
  grape: { light: '#480f8a', dark: '#875fbe' },
  magenta_deep: { light: '#6b0f8a', dark: '#aa4bb9' },
  wine: { light: '#8a0f5d', dark: '#b94b87' },
  maroon: { light: '#8a0f0f', dark: '#be503c' },
  // Soft: lighter, calmer tones (white text still at least 2.6:1).
  rose: { light: '#e35f5f', dark: '#e35f5f' },
  peach: { light: '#e27c5a', dark: '#e27c5a' },
  apricot: { light: '#de8c45', dark: '#de8c45' },
  sky_soft: { light: '#64a6d8', dark: '#64a6d8' },
  iris: { light: '#755fe3', dark: '#7569ff' },
  lilac: { light: '#aa74e7', dark: '#aa74e7' },
  orchid: { light: '#c25fe3', dark: '#c25fe3' },
  blush: { light: '#dc5bad', dark: '#dc5bad' },
  // Neutral: warm and cool greys.
  taupe: { light: '#564d43', dark: '#876e64' },
  stone: { light: '#7f7366', dark: '#7f7366' },
  graphite: { light: '#57616b', dark: '#697882' },
  steel: { light: '#7e8c9a', dark: '#7e8c9a' },
} as const satisfies Record<string, { light: string; dark: string }>;

export type ColorKey = keyof typeof PALETTE;
export type ColorMode = 'light' | 'dark';
export const COLOR_KEYS = Object.keys(PALETTE) as ColorKey[];
const isColorKey = (v: unknown): v is ColorKey => typeof v === 'string' && Object.hasOwn(PALETTE, v);

/**
 * Label keys of the earlier (earthy) palette that were renamed → the key they read as now. Stored data (labels that
 * migration 0080 wrote, an offline cache, an old client) may still carry them; they are never written again.
 */
export const RENAMED_COLOR_KEYS = { brown: 'gold', olive: 'gold' } as const satisfies Record<string, ColorKey>;
const renamedKey = (v: string): ColorKey | undefined =>
  Object.hasOwn(RENAMED_COLOR_KEYS, v) ? RENAMED_COLOR_KEYS[v as keyof typeof RENAMED_COLOR_KEYS] : undefined;

/**
 * The hex values of the earlier (earthy) palette, light and dark → its key now. Migration 0080 wrote them into
 * support tags (0081 moves those to ours); anything else that kept one (a cache, an old event) still reads exactly.
 */
export const EARTHY_PALETTE_HEX: Readonly<Record<string, ColorKey>> = {
  '#2e6b57': 'forest',
  '#6fbf9f': 'forest',
  '#9a6a0b': 'yellow',
  '#d9a24a': 'yellow',
  '#a3413f': 'crimson',
  '#db7f6a': 'crimson',
  '#21727a': 'turquoise',
  '#7cb8b3': 'turquoise',
  '#3d4677': 'navy',
  '#9d9be6': 'navy',
  '#655080': 'purple',
  '#bf9fd4': 'purple',
  '#5b7d33': 'green',
  '#b3c98a': 'green',
  '#b0592b': 'orange',
  '#eb9a69': 'orange',
  '#3a6488': 'blue',
  '#8ab8e0': 'blue',
  '#a8566e': 'pink',
  '#e3a1b4': 'pink',
  '#83674a': 'gold',
  '#cdb08e': 'gold',
  '#6e6a5e': 'gray',
  '#b8b3a6': 'gray',
  '#77702c': 'gold',
  '#c8c07a': 'gold',
  '#557a6d': 'sage',
  '#a2c4b6': 'sage',
  '#4f5f80': 'slate',
  '#a0aac8': 'slate',
  '#8a3d5c': 'plum',
  '#c97f9b': 'plum',
};

/** The palette in its four families, in the order they are defined. */
export const PALETTE_GROUPS = {
  vivid: COLOR_KEYS.slice(0, 16),
  deep: COLOR_KEYS.slice(16, 28),
  soft: COLOR_KEYS.slice(28, 36),
  neutral: COLOR_KEYS.slice(36, 40),
} as const satisfies Record<string, readonly ColorKey[]>;
export type PaletteGroup = keyof typeof PALETTE_GROUPS;
/** A colour's family (vivid / deep / soft / neutral). */
export const paletteGroupOf = (k: ColorKey): PaletteGroup =>
  (Object.keys(PALETTE_GROUPS) as PaletteGroup[]).find((g) => PALETTE_GROUPS[g].includes(k))!;

/** The sixteen vivid colours: what new labels and groups take first. */
export const VIVID_COLORS: readonly ColorKey[] = PALETTE_GROUPS.vivid;

/**
 * The label (status) colours a value takes automatically (a new label, a converted column, a computed label without a
 * colour): the sixteen vivid ones. It stays at sixteen, so a colour picked by index never moves.
 */
export const STATUS_COLORS: readonly ColorKey[] = VIVID_COLORS;

/**
 * Every colour, in the order a colour picker shows them — five rows of eight: vivid (two rows), deep (a row and a
 * half, the four neutral greys completing the fourth row), soft (the fifth).
 */
export const PICKER_COLORS: readonly ColorKey[] = [
  ...PALETTE_GROUPS.vivid,
  ...PALETTE_GROUPS.deep,
  ...PALETTE_GROUPS.neutral,
  ...PALETTE_GROUPS.soft,
];
/** Columns of the colour picker's grid. */
export const PICKER_COLUMNS = 8;

/** An empty status / label: the theme's `--status-empty` (a pseudo key; never stored on a label). */
export const EMPTY_STATUS_COLOR = 'empty';
const EMPTY_HEX = { light: '#c3d0cc', dark: '#2c524b' } as const;

// ---------------------------------------------------------------- groups and tags

/**
 * Group (and tag) colour keys — stored data (the `group_color` enum). Every palette key is one (the first nineteen are
 * the original enum, migration 0083 added the rest); seven old keys are retired and render as a palette colour
 * (`RETIRED_GROUP_COLOR_KEYS`). New groups take `GROUP_AUTO_COLORS` in order (the twelve of `GROUP_PALETTE`, the
 * rest of the vivid ones, then the others); a picker offers all forty (`PICKER_COLORS`). The hex of every key is our
 * palette's light value.
 */
export const GROUP_COLOR_KEYS = [
  'blue',
  'green',
  'forest',
  'lime',
  'orange',
  'red',
  'purple',
  'light_gray',
  'azure',
  'violet',
  'yellow',
  'orange_red',
  'salmon',
  'crimson',
  'pink',
  'turquoise',
  'navy',
  'brown',
  'gray',
  // pal40 (migration 0083): every palette colour may colour a group or a tag.
  'gold',
  'sage',
  'slate',
  'plum',
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
  'rose',
  'peach',
  'apricot',
  'sky_soft',
  'iris',
  'lilac',
  'orchid',
  'blush',
  'taupe',
  'stone',
  'graphite',
  'steel',
] as const;
export type GroupColor = (typeof GROUP_COLOR_KEYS)[number];

/** Retired group keys (still valid as stored data) → the palette colour they render as. */
export const RETIRED_GROUP_COLOR_KEYS = {
  lime: 'green',
  red: 'crimson',
  light_gray: 'gray',
  azure: 'blue',
  orange_red: 'orange',
  salmon: 'pink',
  brown: 'gold',
} as const satisfies Partial<Record<GroupColor, ColorKey>>;

/** The twelve group colours, in the order a new group takes them: green and amber first. */
export const GROUP_PALETTE = [
  'forest',
  'yellow',
  'turquoise',
  'crimson',
  'navy',
  'purple',
  'green',
  'orange',
  'blue',
  'pink',
  'violet',
  'gray',
] as const satisfies readonly (GroupColor & ColorKey)[];

/** The order new groups take colours: the twelve group colours, the rest of the vivid ones, then the others. */
export const GROUP_AUTO_COLORS = [
  ...GROUP_PALETTE,
  ...VIVID_COLORS.filter((k) => !(GROUP_PALETTE as readonly string[]).includes(k)),
  ...PICKER_COLORS.filter((k) => !VIVID_COLORS.includes(k)),
] as (GroupColor & ColorKey)[];

const paletteKeyOfGroup = (k: GroupColor): ColorKey =>
  (RETIRED_GROUP_COLOR_KEYS as Record<string, ColorKey>)[k] ?? (k as ColorKey);

/** Group colour key → hex (light). */
export const GROUP_COLORS = Object.fromEntries(
  GROUP_COLOR_KEYS.map((k) => [k, PALETTE[paletteKeyOfGroup(k)].light]),
) as Record<GroupColor, string>;

/** The group colour keys used before F9 → ours. Stored data, templates and API input may still carry them. */
export const LEGACY_GROUP_COLOR_KEYS: Readonly<Record<string, GroupColor>> = {
  bright_blue: 'blue',
  done_green: 'green',
  grass_green: 'forest',
  bright_green: 'lime',
  working_orange: 'orange',
  stuck_red: 'red',
  explosive: 'light_gray',
  dark_blue: 'azure',
  dark_purple: 'violet',
  egg_yolk: 'yellow',
  dark_orange: 'orange_red',
  sunset: 'salmon',
  dark_red: 'crimson',
  sofia_pink: 'pink',
  aquamarine: 'turquoise',
  american_gray: 'gray',
};

/** A colour key as stored or sent (ours or legacy) → ours; anything else is returned as is. */
export const normalizeGroupColor = <T>(v: T): T | GroupColor =>
  typeof v === 'string' && Object.hasOwn(LEGACY_GROUP_COLOR_KEYS, v) ? LEGACY_GROUP_COLOR_KEYS[v]! : v;

const isGroupColor = (v: unknown): v is GroupColor =>
  typeof v === 'string' && (GROUP_COLOR_KEYS as readonly string[]).includes(v);

/**
 * The hex of a stored group / tag colour key — ours, retired or legacy (an offline cache, an old event, a row the
 * migration did not reach); unknown or empty → `fallback`. On the web render through `paint()` (follows dark mode).
 */
export function groupColorHex(key: string | null | undefined): string;
export function groupColorHex<F>(key: string | null | undefined, fallback: F): string | F;
export function groupColorHex(key: string | null | undefined, fallback: unknown = GROUP_COLORS.forest) {
  const k = normalizeGroupColor(key);
  return isGroupColor(k) ? GROUP_COLORS[k] : fallback;
}

export const groupColorKeySchema = z.enum(GROUP_COLOR_KEYS);
/** Input / stored data: our key or a legacy (pre-F9) key, read as ours. */
export const groupColorInputSchema = z.preprocess(normalizeGroupColor, groupColorKeySchema);

/** A group colour key (ours or legacy), else the closest group palette key to a hex. */
export const groupColorOf = (v: string): GroupColor => {
  const key = normalizeGroupColor(v);
  return isGroupColor(key) ? key : groupColorFromHex(v);
};

/** Closest group palette key for a hex (templates and imports carry hex) — the label mapping, kept to the 12. */
export const groupColorFromHex = (hex: string): GroupColor => {
  const k = colorKeyFromHex(hex);
  if ((GROUP_PALETTE as readonly string[]).includes(k)) return k as GroupColor;
  return nearestKey(hex, GROUP_PALETTE) as GroupColor;
};

// ---------------------------------------------------------------- hex → key (imports, old data)

/**
 * Hex values of the palette the platform used before its own (and that imports from other tools carry) → our key:
 * the nearest colour (ΔE2000 to either mode), with a few semantic choices (the old three-label default
 * becomes in progress / done / blocked). The SQL migration 0080 holds the same table (tested to match), so it keeps
 * the keys it wrote then: `olive` / `brown` are renamed keys now, read through `RENAMED_COLOR_KEYS`.
 * KNOWN-INPUT TABLE: the CI colour guard allows these hex values here and in the import mappers only.
 */
export const LEGACY_LABEL_HEX: Readonly<Record<string, ColorKey | keyof typeof RENAMED_COLOR_KEYS>> = {
  '#00c875': 'forest',
  '#9cd326': 'green',
  '#cab641': 'olive',
  '#ffcb00': 'yellow',
  '#784bd1': 'purple',
  '#9d50dd': 'purple',
  '#007eb5': 'blue',
  '#579bfc': 'blue',
  '#66ccff': 'blue',
  '#bb3354': 'plum',
  '#df2f4a': 'crimson',
  '#ff007f': 'pink',
  '#ff5ac4': 'pink',
  '#ff642e': 'orange',
  '#fdab3d': 'yellow',
  '#7f5347': 'brown',
  '#c4c4c4': 'gray',
  '#757575': 'gray',
  '#e2445c': 'crimson',
  '#0086c0': 'blue',
  '#037f4c': 'forest',
  '#a25ddc': 'purple',
  '#225091': 'navy',
  '#4eccc6': 'turquoise',
  '#a9bee8': 'slate',
  '#ff7575': 'pink',
  '#e484bd': 'plum',
  '#cd9282': 'crimson',
  '#9aadbd': 'slate',
  '#7e3b8a': 'purple',
  '#3d4f5e': 'slate',
  '#ad967a': 'brown',
  '#2b76e5': 'blue',
  '#175a63': 'turquoise',
  '#563e3e': 'brown',
  '#68a1bd': 'blue',
  '#8bc34a': 'green',
  '#f9c449': 'yellow',
  '#4a4a4a': 'gray',
  '#ffadad': 'pink',
  '#ff158a': 'pink',
  '#808080': 'gray',
  '#0073ea': 'blue',
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toLab = (hex: string): [number, number, number] => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(hex).map(lin) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z2 = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z2)];
};

/** CIEDE2000 colour difference of two `#rrggbb` colours (≈2 = just noticeable). */
export const deltaE2000 = (h1: string, h2: string): number => {
  const [L1, a1, b1] = toLab(h1);
  const [L2, a2, b2] = toLab(h2);
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (!a && !b) return 0;
    const t = Math.atan2(b, a) / rad;
    return t < 0 ? t + 360 : t;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dL = L2 - L1;
  const dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p;
  if (C1p * C2p) hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;
  const T =
    1 -
    0.17 * Math.cos((hb - 30) * rad) +
    0.24 * Math.cos(2 * hb * rad) +
    0.32 * Math.cos((3 * hb + 6) * rad) -
    0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
};

const nearestKey = (hex: string, keys: readonly ColorKey[]): ColorKey => {
  let best = keys[0]!;
  let bestD = Infinity;
  for (const k of keys) {
    const d = Math.min(deltaE2000(hex, PALETTE[k].light), deltaE2000(hex, PALETTE[k].dark));
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
};

/**
 * The palette key for any `#rrggbb`: the known table first, then any of our forty exactly, then the nearest of the
 * sixteen vivid colours (pal40: an imported / old hex keeps landing where it did before the deep, soft and neutral
 * colours came — the same choice migration 0080 made).
 */
export const colorKeyFromHex = (hex: string): ColorKey => {
  const h = hex.toLowerCase();
  const known = LEGACY_LABEL_HEX[h];
  if (known) return renamedKey(known) ?? (known as ColorKey);
  for (const k of COLOR_KEYS) if (PALETTE[k].light === h || PALETTE[k].dark === h) return k;
  const earthy = EARTHY_PALETTE_HEX[h];
  if (earthy) return earthy;
  return HEX_RE.test(h) ? nearestKey(h, VIVID_COLORS) : 'gray';
};

/**
 * A label colour as stored or sent → our key: a key stays; a group key (retired / legacy) reads as its palette
 * colour; a hex (old data, an old client, an import) becomes the nearest key. Anything else is returned as is.
 */
export const normalizeLabelColor = <T>(v: T): T | ColorKey => {
  if (typeof v !== 'string') return v;
  if (isColorKey(v)) return v;
  const renamed = renamedKey(v);
  if (renamed) return renamed;
  const g = normalizeGroupColor(v);
  if (isGroupColor(g)) return paletteKeyOfGroup(g);
  if (HEX_RE.test(v)) return colorKeyFromHex(v);
  return v;
};

/** The colour of a new label: an unused vivid colour first, then an unused one of the others, then vivid again. */
export const nextLabelColor = (used: Iterable<string | null | undefined>): ColorKey => {
  const taken = new Set<string>();
  for (const u of used) {
    const k = u ? normalizeLabelColor(u) : null;
    if (k) taken.add(k);
  }
  return (
    VIVID_COLORS.find((c) => !taken.has(c)) ??
    PICKER_COLORS.find((c) => !taken.has(c)) ??
    VIVID_COLORS[taken.size % VIVID_COLORS.length]!
  );
};

/** A label colour as stored or sent → our key; anything unknown → `gray`. */
export const labelColorKey = (v: string | null | undefined): ColorKey => {
  const k = normalizeLabelColor(v);
  return isColorKey(k) ? k : 'gray';
};

export const labelColorKeySchema = z.enum(COLOR_KEYS as [ColorKey, ...ColorKey[]]);
/** A label colour in input or stored data: a key, or a hex read as the nearest key. */
export const labelColorSchema = z.preprocess(normalizeLabelColor, labelColorKeySchema);

/** Any colour value we store (label key, group key, legacy hex, `empty`) → the palette key, or null. */
const keyOf = (v: string | null | undefined): ColorKey | 'empty' | null => {
  if (!v) return null;
  if (v === EMPTY_STATUS_COLOR) return 'empty';
  const k = normalizeLabelColor(v);
  return isColorKey(k) ? k : null;
};

/** A stored colour → a real hex for `mode` (exports, server charts). Unknown → `fallback`. */
export function colorHex(v: string | null | undefined, mode?: ColorMode): string;
export function colorHex<F>(v: string | null | undefined, mode: ColorMode, fallback: F): string | F;
export function colorHex(v: string | null | undefined, mode: ColorMode = 'light', fallback: unknown = EMPTY_HEX.light) {
  const k = keyOf(v);
  if (k === 'empty') return EMPTY_HEX[mode];
  return k ? PALETTE[k][mode] : fallback;
}

/**
 * A stored colour → a CSS colour that follows the theme: a key (label, group — ours, retired or legacy) or an old
 * hex → `var(--c-<key>)`; `empty` → `var(--status-empty)`. Anything else (a CSS variable, null) is returned as is.
 */
export function paint(v: string): string;
export function paint(v: string | null | undefined): string | undefined;
export function paint(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const k = keyOf(v);
  if (k === 'empty') return 'var(--status-empty)';
  return k ? `var(--c-${k})` : v;
}

/**
 * A label chip / status cell (canvas v5 "ג2"): a strong tint of the label's colour with its text in a
 * deep shade of the same colour — no white text on a solid fill. Light: 60% of the colour on white, text 28% of it on
 * black. Dark: 56% on the dark surface, text 12% of it on white. Every palette colour keeps at least 4.5:1 (tested;
 * the tightest are grape in light and sky_soft in dark, both above 4.75:1).
 * (Product decision 2026-10-11: the earlier 45% / 45% light chips sank into the white table; "גוון מלא" lifts the
 * tint and deepens the ink; the dark values rise with them so the two modes keep the same weight.)
 */
const LABEL_TINT = {
  light: { base: '#ffffff', bg: 0.6, ink: '#000000', fg: 0.28 },
  dark: { base: '#0f2e29', bg: 0.56, ink: '#ffffff', fg: 0.12 },
} as const;
const mixHex = (color: string, base: string, share: number) => {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(ch(color, i) * share + ch(base, i) * (1 - share))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};
/** The background of a label chip in `key`'s colour. */
export const labelSoft = (key: ColorKey, mode: ColorMode) =>
  mixHex(PALETTE[key][mode], LABEL_TINT[mode].base, LABEL_TINT[mode].bg);
/** The text of a label chip in `key`'s colour. */
export const labelInk = (key: ColorKey, mode: ColorMode) =>
  mixHex(PALETTE[key][mode], LABEL_TINT[mode].ink, LABEL_TINT[mode].fg);

/** `paint` for a label chip: `var(--c-<key>-soft)` / `var(--c-<key>-ink)`; the empty status keeps its grey. */
export const paintLabel = (v: string | null | undefined): { soft: string; ink: string } | undefined => {
  if (!v) return undefined;
  const k = keyOf(v);
  if (k === 'empty') return { soft: 'var(--status-empty)', ink: 'var(--fg)' };
  return k ? { soft: `var(--c-${k}-soft)`, ink: `var(--c-${k}-ink)` } : undefined;
};

/**
 * The CSS custom properties of the palette for one mode — `--c-<key>` and the label chip's `--c-<key>-soft` /
 * `--c-<key>-ink` (tokens.css carries them; a test checks they match).
 */
export const paletteVars = (mode: ColorMode): Record<string, string> =>
  Object.fromEntries(
    COLOR_KEYS.flatMap((k) => [
      [`--c-${k}`, PALETTE[k][mode]],
      [`--c-${k}-soft`, labelSoft(k, mode)],
      [`--c-${k}-ink`, labelInk(k, mode)],
    ]),
  );

// ---------------------------------------------------------------- default status labels

/** The status labels a new status column starts with (in progress / done / blocked), in Hebrew. */
export const DEFAULT_STATUS_LABELS: { id: number; label: string; color: ColorKey; index: number; is_done?: boolean }[] =
  [
    { id: 0, label: 'בתהליך', color: 'yellow', index: 0 },
    { id: 1, label: 'הושלם', color: 'forest', index: 1, is_done: true },
    { id: 2, label: 'חסום', color: 'crimson', index: 2 },
  ];

/** The same, in English. */
export const DEFAULT_STATUS_LABELS_EN: typeof DEFAULT_STATUS_LABELS = [
  { id: 0, label: 'In progress', color: 'yellow', index: 0 },
  { id: 1, label: 'Done', color: 'forest', index: 1, is_done: true },
  { id: 2, label: 'Blocked', color: 'crimson', index: 2 },
];

/** The default status labels for a language (Hebrew unless English). */
export const defaultStatusLabels = (lang?: string | null) =>
  lang === 'en' ? DEFAULT_STATUS_LABELS_EN : DEFAULT_STATUS_LABELS;
