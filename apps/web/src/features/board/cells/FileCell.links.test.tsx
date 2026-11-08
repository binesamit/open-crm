// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Column } from '@bines/shared';
import type { CellProps } from './index';
import type * as ApiModule from '../../../lib/api';

/**
 * Web links in a files column: a link shows in the cell and opens in a new
 * tab; the popover adds (example.com gains https://), edits and removes links; anything but http(s) is refused.
 */
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('../../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get: vi.fn(), post, patch, delete: del }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

const { FileCell } = await import('./FileCell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const column = { id: 'files', type: 'file', title: 'קבצים', settings: {}, read_only: false } as unknown as Column;
const link = (n: number, name = '') => ({
  id: `l${n}`,
  url: `https://site${n}.test/page`,
  name,
  added_by: 'u1',
  added_at: '2026-10-25T07:00:00.000Z',
});

let root: Root | null = null;
beforeEach(() => {
  for (const f of [post, patch, del]) {
    f.mockReset();
    f.mockResolvedValue({});
  }
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const render = async (value: unknown, editable = true) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const props = {
    column,
    value,
    text: null,
    editable,
    accountId: 'acc',
    itemId: 'item1',
    boardId: 'b1',
    members: [],
    onChange: vi.fn(),
    canEditSettings: false,
    onSettingsChange: vi.fn(),
  } as unknown as CellProps;
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(FileCell, props)));
  });
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
};
const type = async (id: string, value: string) => {
  const input = $(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = async () => {
  const form = $('file-cell-link-form') as HTMLFormElement;
  await act(async () => form.requestSubmit());
};

describe('files column: links', () => {
  it('shows the first link in the cell (its name, else its address) opening in a new tab, then +N', async () => {
    await render({ files: [], links: [link(1, 'Drive'), link(2)] });
    const chip = $('file-cell-link') as HTMLAnchorElement;
    expect(chip.getAttribute('href')).toBe('https://site1.test/page');
    expect(chip.getAttribute('target')).toBe('_blank');
    expect(chip.getAttribute('rel')).toContain('noopener');
    expect(chip.textContent).toBe('Drive');
    expect($('file-cell-links-more')!.textContent).toBe('+1');
    await click($('file-cell'));
    expect(all('file-cell-link-open').map((a) => a.textContent)).toEqual(['Drive', 'site2.test/page']);
  });

  it('adds a link: an address without a scheme gains https://, the name is optional', async () => {
    await render({ files: [] });
    await click($('file-cell'));
    await click($('file-cell-add-link'));
    await type('file-cell-link-url', 'drive.google.com/x');
    await type('file-cell-link-name', ' תיקיית הלקוח ');
    await submit();
    expect(post).toHaveBeenCalledWith('/items/item1/cells/files/links', {
      url: 'https://drive.google.com/x',
      name: 'תיקיית הלקוח',
    });
    expect($('file-cell-link-form')).toBeNull();
  });

  it('refuses anything but http(s) before calling the server', async () => {
    await render({ files: [] });
    await click($('file-cell'));
    await click($('file-cell-add-link'));
    await type('file-cell-link-url', 'javascript:alert(1)');
    await submit();
    expect($('file-cell-link-invalid')).not.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('edits and removes a link', async () => {
    await render({ files: [], links: [link(1, 'Old')] });
    await click($('file-cell'));
    await click($('file-cell-link-edit'));
    expect(($('file-cell-link-url') as HTMLInputElement).value).toBe('https://site1.test/page');
    await type('file-cell-link-name', 'New');
    await submit();
    expect(patch).toHaveBeenCalledWith('/items/item1/cells/files/links/l1', {
      url: 'https://site1.test/page',
      name: 'New',
    });
    await click($('file-cell-link-remove'));
    expect(del).toHaveBeenCalledWith('/items/item1/cells/files/links/l1');
  });

  it('a read-only cell opens links but offers no add / edit / remove', async () => {
    await render({ files: [], links: [link(1)] }, false);
    await click($('file-cell'));
    expect(all('file-cell-link-open')).toHaveLength(1);
    expect($('file-cell-add-link')).toBeNull();
    expect($('file-cell-link-edit')).toBeNull();
    expect($('file-cell-link-remove')).toBeNull();
  });
});
