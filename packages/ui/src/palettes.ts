// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round 12 ("let the interface's colours be changed — by predefined templates… without hurting the
 * contrast"). Colour themes ("palettes") on top of the token system (tokens.css): each one re-tints the brand
 * tokens — the shell, the ink, the soft tints, the lines — and defines BOTH a light and a dark variant, so the
 * light / dark / system choice keeps working under any palette. F4 (deep green) is the default and changes
 * nothing. Every palette passes WCAG AA on the token pairs the app draws text with (`CONTRAST_PAIRS`, checked by
 * a unit test, and by the E2E page audit `e2e/contrast.ts` over each palette).
 *
 * Applied as <html data-palette="…"> with one generated stylesheet (`paletteCss`) — data, not CSS per palette.
 */
export type Tokens = Record<string, string>;

export type Palette = {
  id: string;
  /** i18n key of its name. */
  label: string;
  /** Three colours for the picker's swatch: shell, ink tint, accent. */
  swatch: [string, string, string];
  light: Tokens;
  /** Must override every token `light` does (else a light value would leak into dark mode) — tested. */
  dark: Tokens;
  /** The light sidebar (a per-user choice) in this palette's tint, while the interface is light. */
  sidebarLight?: Tokens;
};

export const DEFAULT_PALETTE = 'f4';

export const PALETTES: Palette[] = [
  { id: 'f4', label: 'r12.palette.f4', swatch: ['#0d3b35', '#e3efeb', '#ffb020'], light: {}, dark: {} },
  {
    id: 'ocean',
    label: 'r12.palette.ocean',
    swatch: ['#0b2e4f', '#e2ecf6', '#ffb020'],
    light: {
      '--shell': '#0b2e4f',
      '--shell-fg': '#d3e3f2',
      '--shell-muted': '#93b3d1',
      '--heading': '#0b2e4f',
      '--primary': '#0b2e4f',
      '--primary-soft': '#e2ecf6',
      '--on-accent': '#0b2e4f',
      '--check': '#0b2e4f',
      '--bar': '#0b2e4f',
      '--bar-track': '#56708a',
      '--surface-2': '#f0f4f9',
      '--surface-3': '#f6f9fc',
      '--fg': '#111e2b',
      '--fg-2': '#31475e',
      '--muted': '#566b80',
      '--line': '#e1e8f0',
      '--line-soft': '#edf2f7',
      '--line-strong': '#d2dce8',
      '--row-alt': '#fbfcfe',
      '--switch-off': '#c5d2df',
      '--status-empty': '#c3ccd6',
      '--mark-off': '#7b8b9d',
      '--toast-bg': '#111e2b',
      '--toast-fg': '#f2f6fb',
      '--scrim': 'rgba(6, 22, 38, 0.42)',
      '--shadow-pop': '0 12px 32px rgba(11, 46, 79, 0.18)',
    },
    dark: {
      '--shell': '#071a2e',
      '--shell-fg': '#d3e3f2',
      '--shell-muted': '#86a5c4',
      '--surface': '#0f2236',
      '--surface-2': '#16304a',
      '--surface-3': '#12293f',
      '--fg': '#e3ecf5',
      '--heading': '#f2f6fb',
      '--fg-2': '#b5c7da',
      '--muted': '#93aac2',
      '--line': '#1f3a55',
      '--line-soft': '#183149',
      '--line-strong': '#2a4866',
      '--primary': '#f2f6fb',
      '--on-primary': '#0b2e4f',
      '--primary-soft': '#1d3d5e',
      '--on-accent': '#0b2e4f',
      '--check': '#7cc0ff',
      '--bar': '#2a64a0',
      '--bar-track': '#20384f',
      '--panel-border': '#1d3a55',
      '--row-alt': '#11263b',
      '--switch-off': '#4a6580',
      '--status-empty': '#2c4560',
      '--mark-off': '#5f7d9b',
      '--toast-bg': '#f2f6fb',
      '--toast-fg': '#0b2e4f',
      '--scrim': 'rgba(0, 0, 0, 0.55)',
      '--shadow-pop': '0 14px 36px rgba(0, 0, 0, 0.55)',
    },
    sidebarLight: {
      '--shell': '#ebf1f7',
      '--shell-fg': '#31475e',
      '--shell-muted': '#566b80',
      '--shell-strong': '#0b2e4f',
      '--panel-border': '#d9e3ee',
    },
  },
  {
    id: 'plum',
    label: 'r12.palette.plum',
    swatch: ['#3b1a4f', '#efe5f5', '#ffb020'],
    light: {
      '--shell': '#3b1a4f',
      '--shell-fg': '#eadcf2',
      '--shell-muted': '#bfa0d1',
      '--heading': '#3b1a4f',
      '--primary': '#3b1a4f',
      '--primary-soft': '#efe5f5',
      '--on-accent': '#3b1a4f',
      '--check': '#3b1a4f',
      '--bar': '#3b1a4f',
      '--bar-track': '#725d7d',
      '--surface-2': '#f6f1f9',
      '--surface-3': '#faf7fc',
      '--fg': '#22152b',
      '--fg-2': '#4b3558',
      '--muted': '#6c5978',
      '--line': '#ebe2f0',
      '--line-soft': '#f3edf7',
      '--line-strong': '#dfd2e7',
      '--row-alt': '#fdfbfe',
      '--switch-off': '#d5c8dd',
      '--status-empty': '#cfc4d6',
      '--mark-off': '#8b7d95',
      '--toast-bg': '#22152b',
      '--toast-fg': '#faf5fc',
      '--scrim': 'rgba(30, 12, 40, 0.42)',
      '--shadow-pop': '0 12px 32px rgba(59, 26, 79, 0.18)',
    },
    dark: {
      '--shell': '#1f0c2b',
      '--shell-fg': '#eadcf2',
      '--shell-muted': '#ad8fc2',
      '--surface': '#2a1538',
      '--surface-2': '#361d47',
      '--surface-3': '#301a40',
      '--fg': '#f0e6f5',
      '--heading': '#faf5fc',
      '--fg-2': '#d6c4e1',
      '--muted': '#bba5cb',
      '--line': '#452a57',
      '--line-soft': '#3a2249',
      '--line-strong': '#523466',
      '--primary': '#faf5fc',
      '--on-primary': '#3b1a4f',
      '--primary-soft': '#4a2b5e',
      '--on-accent': '#3b1a4f',
      '--check': '#d6a8ff',
      '--bar': '#7b43a6',
      '--bar-track': '#432a54',
      '--panel-border': '#452a57',
      '--row-alt': '#2d1739',
      '--switch-off': '#6a5079',
      '--status-empty': '#503a60',
      '--mark-off': '#82699a',
      '--toast-bg': '#faf5fc',
      '--toast-fg': '#3b1a4f',
      '--scrim': 'rgba(0, 0, 0, 0.55)',
      '--shadow-pop': '0 14px 36px rgba(0, 0, 0, 0.55)',
    },
    sidebarLight: {
      '--shell': '#f3edf7',
      '--shell-fg': '#4b3558',
      '--shell-muted': '#6c5978',
      '--shell-strong': '#3b1a4f',
      '--panel-border': '#e6dbed',
    },
  },
  {
    id: 'graphite',
    label: 'r12.palette.graphite',
    swatch: ['#23272e', '#e9ebee', '#ffb020'],
    light: {
      '--shell': '#23272e',
      '--shell-fg': '#d9dde2',
      '--shell-muted': '#a0a7b1',
      '--heading': '#1f2329',
      '--primary': '#23272e',
      '--primary-soft': '#e9ebee',
      '--on-accent': '#23272e',
      '--check': '#23272e',
      '--bar': '#23272e',
      '--bar-track': '#5f6670',
      '--surface-2': '#f2f3f5',
      '--surface-3': '#f8f9fa',
      '--fg': '#16191d',
      '--fg-2': '#3c424a',
      '--muted': '#5f6670',
      '--line': '#e4e6e9',
      '--line-soft': '#eff0f2',
      '--line-strong': '#d6d9dd',
      '--row-alt': '#fcfcfd',
      '--switch-off': '#cdd1d6',
      '--status-empty': '#c8ccd1',
      '--mark-off': '#828993',
      '--toast-bg': '#16191d',
      '--toast-fg': '#f5f6f7',
      '--scrim': 'rgba(15, 17, 20, 0.42)',
      '--shadow-pop': '0 12px 32px rgba(20, 22, 26, 0.18)',
    },
    dark: {
      '--shell': '#121417',
      '--shell-fg': '#d9dde2',
      '--shell-muted': '#949ba5',
      '--surface': '#1b1e23',
      '--surface-2': '#252930',
      '--surface-3': '#20242a',
      '--fg': '#e7e9ec',
      '--heading': '#f5f6f7',
      '--fg-2': '#c0c5cc',
      '--muted': '#a0a7b1',
      '--line': '#31363e',
      '--line-soft': '#2a2e35',
      '--line-strong': '#3d434c',
      '--primary': '#f5f6f7',
      '--on-primary': '#23272e',
      '--primary-soft': '#343a43',
      '--on-accent': '#23272e',
      '--check': '#9ec5ff',
      '--bar': '#4b5563',
      '--bar-track': '#2e333a',
      '--panel-border': '#31363e',
      '--row-alt': '#1e2126',
      '--switch-off': '#555c66',
      '--status-empty': '#3a4048',
      '--mark-off': '#6e757f',
      '--toast-bg': '#f5f6f7',
      '--toast-fg': '#23272e',
      '--scrim': 'rgba(0, 0, 0, 0.55)',
      '--shadow-pop': '0 14px 36px rgba(0, 0, 0, 0.55)',
    },
    sidebarLight: {
      '--shell': '#f0f1f3',
      '--shell-fg': '#3c424a',
      '--shell-muted': '#5f6670',
      '--shell-strong': '#1f2329',
      '--panel-border': '#dfe2e6',
    },
  },
  {
    id: 'terracotta',
    label: 'r12.palette.terracotta',
    swatch: ['#5a2a1c', '#f6e9e3', '#ffb020'],
    light: {
      '--shell': '#5a2a1c',
      '--shell-fg': '#f4e1d9',
      '--shell-muted': '#d9b0a0',
      '--heading': '#5a2a1c',
      '--primary': '#5a2a1c',
      '--primary-soft': '#f6e9e3',
      '--on-accent': '#5a2a1c',
      '--check': '#5a2a1c',
      '--bar': '#5a2a1c',
      '--bar-track': '#7c665e',
      '--surface-2': '#f9f3f0',
      '--surface-3': '#fcf8f6',
      '--fg': '#2a1a14',
      '--fg-2': '#573a30',
      '--muted': '#765e56',
      '--line': '#efe3dd',
      '--line-soft': '#f5ece8',
      '--line-strong': '#e5d4cc',
      '--row-alt': '#fefcfb',
      '--switch-off': '#dfcdc5',
      '--status-empty': '#d8c9c2',
      '--mark-off': '#94817a',
      '--toast-bg': '#2a1a14',
      '--toast-fg': '#fdf6f3',
      '--scrim': 'rgba(40, 18, 10, 0.42)',
      '--shadow-pop': '0 12px 32px rgba(90, 42, 28, 0.18)',
    },
    dark: {
      '--shell': '#2a130c',
      '--shell-fg': '#f4e1d9',
      '--shell-muted': '#c49585',
      '--surface': '#34190f',
      '--surface-2': '#422217',
      '--surface-3': '#3b1d13',
      '--fg': '#f6e9e3',
      '--heading': '#fdf6f3',
      '--fg-2': '#dfc6bb',
      '--muted': '#c6a698',
      '--line': '#52301f',
      '--line-soft': '#472818',
      '--line-strong': '#613a27',
      '--primary': '#fdf6f3',
      '--on-primary': '#5a2a1c',
      '--primary-soft': '#5a3221',
      '--on-accent': '#5a2a1c',
      '--check': '#ffb38a',
      '--bar': '#9a4a2a',
      '--bar-track': '#4d2d1f',
      '--panel-border': '#52301f',
      '--row-alt': '#381b11',
      '--switch-off': '#75513f',
      '--status-empty': '#5c3a2b',
      '--mark-off': '#8f6b5b',
      '--toast-bg': '#fdf6f3',
      '--toast-fg': '#5a2a1c',
      '--scrim': 'rgba(0, 0, 0, 0.55)',
      '--shadow-pop': '0 14px 36px rgba(0, 0, 0, 0.55)',
    },
    sidebarLight: {
      '--shell': '#f8f0ec',
      '--shell-fg': '#573a30',
      '--shell-muted': '#765e56',
      '--shell-strong': '#5a2a1c',
      '--panel-border': '#ecddd6',
    },
  },
];

export const paletteById = (id: string | null | undefined) =>
  PALETTES.find((p) => p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE)!;

const block = (selector: string, tokens: Tokens) => {
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return body ? `${selector}{${body}}` : '';
};

/**
 * The stylesheet for every palette: light under `:root[data-palette=x]`, dark under an explicit dark choice and
 * under the system's dark preference (like tokens.css), the light sidebar under a light interface. Selectors are
 * one step more specific than tokens.css, so a palette wins whatever the order.
 */
export const paletteCss = (palettes: Palette[] = PALETTES): string =>
  palettes
    .filter((p) => Object.keys(p.light).length || Object.keys(p.dark).length)
    .map((p) => {
      const at = `:root[data-palette='${p.id}']`;
      return [
        block(at, p.light),
        block(`${at}[data-theme='dark']`, p.dark),
        `@media (prefers-color-scheme: dark){${block(`${at}:not([data-theme='light'])`, p.dark)}}`,
        p.sidebarLight ? block(`${at}[data-theme='light'] [data-sidebar='light']`, p.sidebarLight) : '',
        p.sidebarLight
          ? `@media (prefers-color-scheme: light){${block(`${at}:not([data-theme='dark']) [data-sidebar='light']`, p.sidebarLight)}}`
          : '',
      ].join('');
    })
    .join('\n');

const STYLE_ID = 'bines-palettes';

/** Puts a palette on <html data-palette> (the stylesheet once); the default palette removes the attribute. */
export const applyPalette = (id: string, root: HTMLElement = document.documentElement): void => {
  if (!document.getElementById(STYLE_ID)) {
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = paletteCss();
    document.head.appendChild(el);
  }
  const p = paletteById(id);
  if (p.id === DEFAULT_PALETTE) root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', p.id);
};

// ---------------------------------------------------------------- contrast (WCAG 2.x)

type RGB = [number, number, number];

/** `#rgb`, `#rrggbb` or `rgba(r, g, b, a)` → rgb + alpha. */
export const parseColor = (c: string): { rgb: RGB; a: number } | null => {
  const s = c.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join('') : hex[1]!;
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB, a: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1]!.split(',').map((x) => Number(x.trim()));
  return { rgb: [r!, g!, b!], a };
};

const over = (top: { rgb: RGB; a: number }, base: RGB): RGB =>
  top.rgb.map((v, i) => Math.round(v * top.a + base[i]! * (1 - top.a))) as RGB;

const luminance = ([r, g, b]: RGB) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};

/** Contrast ratio of `fg` over `bg` (a translucent colour is laid over `under`, default white). */
export const contrastRatio = (fg: string, bg: string, under = '#ffffff') => {
  const u = parseColor(under)!.rgb;
  const b = parseColor(bg);
  const f = parseColor(fg);
  if (!b || !f) return 0;
  const bgRgb = over(b, u);
  const fgRgb = over(f, bgRgb);
  const [l1, l2] = [luminance(fgRgb), luminance(bgRgb)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
};

/**
 * The token pairs the app draws text (4.5:1) and controls (3:1, WCAG 1.4.11) with. `under`: what a translucent
 * background sits on.
 */
export const CONTRAST_PAIRS: { fg: string; bg: string; min: number; under?: string }[] = [
  { fg: '--fg', bg: '--surface', min: 4.5 },
  { fg: '--fg', bg: '--surface-2', min: 4.5 },
  { fg: '--fg', bg: '--row-alt', min: 4.5 },
  { fg: '--fg', bg: '--info-soft', min: 4.5, under: '--surface' },
  { fg: '--fg-2', bg: '--surface', min: 4.5 },
  { fg: '--fg-2', bg: '--surface-2', min: 4.5 },
  { fg: '--muted', bg: '--surface', min: 4.5 },
  { fg: '--muted', bg: '--surface-2', min: 4.5 },
  { fg: '--muted', bg: '--surface-3', min: 4.5 },
  { fg: '--heading', bg: '--surface', min: 4.5 },
  { fg: '--heading', bg: '--surface-2', min: 4.5 },
  { fg: '--primary', bg: '--surface', min: 4.5 },
  { fg: '--primary', bg: '--primary-soft', min: 4.5 },
  { fg: '--on-primary', bg: '--primary', min: 4.5 },
  { fg: '--on-accent', bg: '--accent', min: 4.5 },
  { fg: '--accent-fg', bg: '--surface', min: 4.5 },
  { fg: '--accent-fg', bg: '--accent-soft', min: 4.5, under: '--surface' },
  { fg: '--danger-fg', bg: '--surface', min: 4.5 },
  { fg: '--info-fg', bg: '--surface', min: 4.5 },
  { fg: '--ok-fg', bg: '--surface', min: 4.5 },
  { fg: '--shell-fg', bg: '--shell', min: 4.5 },
  { fg: '--shell-muted', bg: '--shell', min: 4.5 },
  { fg: '--shell-strong', bg: '--shell', min: 4.5 },
  { fg: '--toast-fg', bg: '--toast-bg', min: 4.5 },
  { fg: '--on-bar', bg: '--bar', min: 4.5 },
  { fg: '--on-bar', bg: '--bar-track', min: 4.5 },
  { fg: '--check', bg: '--surface', min: 3 },
  { fg: '--focus-ring', bg: '--surface', min: 3 },
  { fg: '--focus-ring', bg: '--shell', min: 3 },
  { fg: '--mark-off', bg: '--surface', min: 3 },
  { fg: '--rating', bg: '--surface', min: 3 },
];
