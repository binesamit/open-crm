// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { cn } from './components';

export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

/** Fallback colours (F4): deep enough for white initials (≥ 4.5:1), told apart by lightness too. */
const AVATAR_COLORS = ['#2f6fe0', '#c2410c', '#8a4fd8', '#0d8050', '#b4235a', '#0e7490', '#a16207', '#4f46e5'];
export const avatarColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
};

/**
 * Profile photo with an initials fallback (11-UI-DESIGN: Avatar). A broken or expired link falls back to
 * initials instead of showing a broken image.
 */
export const Avatar = ({
  name,
  url,
  size = 24,
  className,
}: {
  name: string;
  url?: string | null;
  size?: number;
  className?: string;
}) => {
  const [failed, setFailed] = useState<string | null>(null);
  // Round 13: in rem — avatars follow the user's text size.
  const style = {
    width: `${size / 16}rem`,
    height: `${size / 16}rem`,
    fontSize: `${Math.max(9, Math.round(size * 0.4)) / 16}rem`,
  };
  const fallback = { ...style, backgroundColor: avatarColor(name) };
  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt={name}
        title={name}
        onError={() => setFailed(url)}
        style={style}
        className={cn('shrink-0 rounded-full bg-surface-2 object-cover', className)}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={fallback}
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
    >
      {initialsOf(name)}
    </span>
  );
};

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};

/**
 * Text colour on a label fill (11-UI §9): WHITE — on every label colour of the palettes (orange,
 * green, light blue, yellow…), Fix: ("the labels' text should be white, not black"). White on a coloured
 * label is the accepted exception to the 4.5:1 rule (the label is identified by its colour and its text together);
 * only a genuinely pale custom fill (white would be under 1.4:1 — near-white, pale cream) takes the dark ink. Fills
 * keep their exact colours. Anything that is not a #rrggbb colour (a token) keeps white.
 */
export const readableOn = (color: string | null | undefined) => {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return '#ffffff';
  const onWhite = 1.05 / (luminance(color) + 0.05);
  return onWhite < 1.4 ? '#13221f' : '#ffffff';
};

const rgbOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const lumRgb = (c: readonly number[]) => {
  const ch = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};
const contrastRgb = (a: readonly number[], b: readonly number[]) => {
  const [x, y] = [lumRgb(a), lumRgb(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
// The themes' text ink and the surfaces coloured text sits on (tokens.css: --fg, --surface, --surface-2, --row-alt).
const THEMES = [
  { fg: rgbOf('#13221f'), bgs: ['#ffffff', '#f1f6f4', '#fcfdfd'].map(rgbOf) },
  { fg: rgbOf('#e3efec'), bgs: ['#0f2e29', '#163a34', '#11302b'].map(rgbOf) },
];

/**
 * Text drawn *in* a colour (a `#tag`, a group's title) on the content surfaces (Fix: , WCAG AA): the colour
 * mixed with the theme's text ink (`--fg`) just enough to reach 4.5:1 in both themes — dark colours stay as they
 * are, light ones (yellow, lime) take some ink. Returns a CSS colour (`color-mix`, so it follows the theme).
 */
export const inkOf = (color: string | null | undefined): string | undefined => {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return color ?? undefined;
  const c = rgbOf(color);
  const passes = (p: number) =>
    THEMES.every(({ fg, bgs }) => {
      const m = c.map((v, i) => v * p + fg[i]! * (1 - p));
      return bgs.every((bg) => contrastRgb(m, bg) >= 4.6);
    });
  for (let p = 100; p > 0; p -= 5)
    if (passes(p / 100)) return p === 100 ? color : `color-mix(in srgb, ${color} ${p}%, var(--fg))`;
  return 'var(--fg)';
};
