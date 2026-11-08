// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { swapFavicon } from './favicon';

const icons = () =>
  [...document.head.querySelectorAll('link[rel="icon"]')].map((l) => [l.getAttribute('href'), l.getAttribute('type')]);

afterEach(() => {
  document.head.innerHTML = '';
});

describe('the tab icon (f9-icon)', () => {
  it("points every icon link at the account's icon and puts the defaults back", () => {
    document.head.innerHTML =
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">' +
      '<link rel="icon" sizes="16x16" href="/favicon-16.png">' +
      '<link rel="apple-touch-icon" href="/apple.png">';
    const undo = swapFavicon('/api/v1/public/pwa/a/A1/icon/favicon-32.png?v=x');
    expect(icons()).toEqual([
      ['/api/v1/public/pwa/a/A1/icon/favicon-32.png?v=x', 'image/png'],
      ['/api/v1/public/pwa/a/A1/icon/favicon-32.png?v=x', 'image/png'],
    ]);
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href')).toBe('/apple.png');
    undo();
    expect(icons()).toEqual([
      ['/favicon-32.png', 'image/png'],
      ['/favicon-16.png', null],
    ]);
  });

  it('switching accounts: the second account replaces the first, and leaving both restores the default', () => {
    document.head.innerHTML = '<link rel="icon" type="image/png" href="/favicon-32.png">';
    const undoA = swapFavicon('/a.png');
    // React runs the old effect's cleanup before the new one.
    undoA();
    const undoB = swapFavicon('/b.png');
    expect(icons()).toEqual([['/b.png', 'image/png']]);
    undoB();
    expect(icons()).toEqual([['/favicon-32.png', 'image/png']]);
  });

  it('adds a link when the page has none, and removes it again', () => {
    const undo = swapFavicon('/a.png');
    expect(icons()).toEqual([['/a.png', 'image/png']]);
    undo();
    expect(icons()).toEqual([]);
  });
});
