// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { hasMessage } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import { AVATAR_ANIMALS, AVATAR_BACKGROUNDS, avatarDataUrl, avatarSvg } from './avatars';

/** The built-in avatars (the product owner picked the animals). */
describe('built-in avatars', () => {
  it('has eight animals with unique ids, each named in Hebrew and English', () => {
    expect(AVATAR_ANIMALS).toHaveLength(8);
    expect(new Set(AVATAR_ANIMALS.map((a) => a.id)).size).toBe(8);
    for (const a of AVATAR_ANIMALS) expect(hasMessage(`avatar.animal.${a.id}`)).toBe(true);
  });

  it('draws every animal as a well-formed SVG on the chosen background', () => {
    for (const a of AVATAR_ANIMALS)
      for (const bg of [undefined, AVATAR_BACKGROUNDS[3]]) {
        const svg = avatarSvg(a, bg, 512);
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(doc.querySelector('parsererror'), a.id).toBeNull();
        expect(doc.documentElement.getAttribute('width')).toBe('512');
        expect(doc.querySelector('rect')?.getAttribute('fill')).toBe(bg ?? a.bg);
      }
  });

  it('starts every animal on one of the backgrounds a viewer can pick', () => {
    for (const a of AVATAR_ANIMALS) expect(AVATAR_BACKGROUNDS).toContain(a.bg);
  });

  it('gives an <img> a data URL', () => {
    expect(avatarDataUrl(AVATAR_ANIMALS[0]!)).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  });
});
