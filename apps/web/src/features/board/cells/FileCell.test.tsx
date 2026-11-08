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
 * an image in a files column shows as a small preview in the cell (up to three, then "+N"; other files
 * keep the 📎 count); a preview opens the viewer on that image; a column setting turns previews off.
 */
const get = vi.fn();
vi.mock('../../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn(), delete: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../../files/FileViewer', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FileViewer: ({ startIndex }: { startIndex: number }) =>
    createElement('div', { 'data-testid': 'viewer', 'data-start': startIndex }),
}));

const { FileCell } = await import('./FileCell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const column = (settings = {}) =>
  ({ id: 'files', type: 'file', title: 'קבצים', settings, read_only: false }) as unknown as Column;
const img = (n: number, size = 2000) => ({ asset_id: `img${n}`, name: `photo${n}.png`, size, mime: 'image/png' });
const pdf = { asset_id: 'pdf1', name: 'contract.pdf', size: 5000, mime: 'application/pdf' };

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (path: string) => ({ download_url: `https://files.test${path}` }));
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const render = async (value: unknown, col = column()) => {
  const props = {
    column: col,
    value,
    text: null,
    editable: true,
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
  await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('files column: image previews', () => {
  it('shows images as previews (three, then +N) and keeps the count for other files', async () => {
    await render({ files: [img(1), pdf, img(2), img(3), img(4)] });
    const previews = all('file-cell-preview');
    expect(previews).toHaveLength(3);
    expect(previews[0]!.querySelector('img')!.getAttribute('src')).toBe('https://files.test/files/img1?inline=1');
    expect(all('file-cell-more')[0]!.textContent).toBe('+1');
    expect(all('file-cell')[0]!.textContent).toContain('📎 1');
  });

  it('a preview opens the viewer on that image, not the cell’s list', async () => {
    await render({ files: [pdf, img(1)] });
    await act(async () => all('file-cell-preview')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(all('viewer')[0]!.dataset.start).toBe('1');
    expect(all('file-cell-open')).toHaveLength(0);
  });

  it('a very large image keeps the plain count (a preview would download all of it)', async () => {
    await render({ files: [img(1, 50 * 1024 * 1024)] });
    expect(all('file-cell-preview')).toHaveLength(0);
    expect(all('file-cell')[0]!.textContent).toContain('📎 1');
    expect(get).not.toHaveBeenCalled();
  });

  it('turned off in the column settings: the count only, nothing fetched', async () => {
    await render({ files: [img(1), img(2)] }, column({ image_previews: false }));
    expect(all('file-cell-preview')).toHaveLength(0);
    expect(all('file-cell')[0]!.textContent).toContain('📎 2');
    expect(get).not.toHaveBeenCalled();
  });
});
