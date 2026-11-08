// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { selectedTextIn, withSelectionCopy, type MenuEntry } from '@bines/ui';

/**
 * our own right-click menu replaces the browser's, so text selected in an update (or any row with such a
 * menu) could not be copied from it — the menu now starts with "Copy selected text".
 */
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

const select = (node: Node, from: number, toNode: Node, to: number) => {
  const r = document.createRange();
  r.setStart(node, from);
  r.setEnd(toNode, to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
};

describe('selectedTextIn', () => {
  it('the text selected inside the element', () => {
    document.body.innerHTML = '<div id="a"><p>hello world</p></div><div id="b">other</div>';
    const text = document.querySelector('#a p')!.firstChild!;
    select(text, 6, text, 11);
    expect(selectedTextIn(document.getElementById('a')!)).toBe('world');
  });
  it('nothing when the selection is elsewhere or collapsed', () => {
    document.body.innerHTML = '<div id="a"><p>hello</p></div><div id="b">other</div>';
    const other = document.getElementById('b')!.firstChild!;
    select(other, 0, other, 5);
    expect(selectedTextIn(document.getElementById('a')!)).toBe('');
    const text = document.querySelector('#a p')!.firstChild!;
    select(text, 2, text, 2);
    expect(selectedTextIn(document.getElementById('a')!)).toBe('');
  });
  it('a selection running past the element: only its own part', () => {
    document.body.innerHTML = '<div id="a">first</div><div id="b">second</div>';
    select(document.getElementById('a')!.firstChild!, 2, document.getElementById('b')!.firstChild!, 3);
    expect(selectedTextIn(document.getElementById('a')!)).toBe('rst');
  });
});

describe('withSelectionCopy', () => {
  const items: MenuEntry[] = [{ label: 'Edit', onSelect: () => undefined }];
  it('no selection: the menu as is', () => {
    expect(withSelectionCopy(items, undefined)).toBe(items);
  });
  it('a selection: "copy" first, then a separator and the menu', () => {
    const out = withSelectionCopy(items, 'abc');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ testId: 'menu-copy-selection' });
    expect(out[1]).toEqual({ kind: 'separator' });
    expect(out[2]).toBe(items[0]);
  });
});
