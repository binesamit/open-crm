// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ICON_STYLE, ICON_STYLES } from '@bines/shared';
import { TYPE_GLYPH } from '../features/board/table/type-glyphs';
import { setIconStyle } from './icon-style';
import { Icon, ICON_NAMES, ICON_STYLE_DEFS, iconParts } from './icons';

/** every icon is drawn in the user's icon style (two-tone by default); each style is a row of data. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  act(() => setIconStyle(DEFAULT_ICON_STYLE));
});
const draw = (el: ReactElement) => {
  root = createRoot(host);
  act(() => root!.render(el));
  return host.querySelector('svg')!;
};

describe('icon parts', () => {
  it('every icon (and column-type glyph) has parts and at most one accent part', () => {
    for (const parts of [...ICON_NAMES.map(iconParts), ...Object.values(TYPE_GLYPH)]) {
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.filter(([role]) => role.endsWith('*')).length).toBeLessThanOrEqual(1);
    }
  });
  it('every style has a definition', () => {
    for (const s of ICON_STYLES) expect(ICON_STYLE_DEFS[s]).toBeTruthy();
  });
});

describe('Icon styles', () => {
  it('two-tone by default: the main shape tinted, the accent part stronger', () => {
    const svg = draw(<Icon name="kanban" />);
    expect(svg.getAttribute('data-icon-style')).toBe('duo');
    const rects = [...svg.querySelectorAll('rect')];
    expect(rects[0]!.getAttribute('style')).toContain('var(--icon-tint)');
    expect(rects[1]!.getAttribute('style')).toContain('var(--icon-tint-strong)');
  });
  it('follows the chosen style live', () => {
    const svg = draw(<Icon name="kanban" />);
    act(() => setIconStyle('line'));
    expect(svg.getAttribute('data-icon-style')).toBe('line');
    expect(svg.querySelector('rect')!.getAttribute('style')).toBeNull();
    expect(document.documentElement.getAttribute('data-icon-style')).toBe('line');
  });
  it('solid fills the main shape and cuts the details out with a mask', () => {
    const svg = draw(<Icon name="calendar" iconStyle="solid" />);
    const mask = svg.querySelector('mask')!;
    expect(mask).toBeTruthy();
    expect(svg.querySelector(`g[mask="url(#${mask.id})"]`)!.getAttribute('fill')).toBe('currentColor');
  });
  it('sharp squares the corners and caps, bold thickens and rounds them', () => {
    const sharp = draw(<Icon name="board" iconStyle="sharp" />);
    expect(sharp.getAttribute('stroke-linecap')).toBe('square');
    expect(sharp.querySelector('rect')!.getAttribute('rx')).toBe('0');
    act(() => root!.render(<Icon name="board" iconStyle="bold" />));
    const bold = host.querySelector('svg')!;
    expect(Number(bold.getAttribute('stroke-width'))).toBeGreaterThan(1.8);
    expect(Number(bold.querySelector('rect')!.getAttribute('rx'))).toBeGreaterThan(2);
  });
  it('accent draws only the accent part in amber', () => {
    const svg = draw(<Icon name="home" iconStyle="accent" />);
    const paths = [...svg.querySelectorAll('path')];
    expect(paths.filter((p) => p.getAttribute('style')?.includes('var(--icon-accent)'))).toHaveLength(1);
  });
});
