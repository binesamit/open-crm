// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@bines/shared';
import type * as ApiModule from '../../lib/api';
import type { ViewerFile } from './FileViewer';

/**
 * HTML files in the viewer: the page itself in a sandboxed frame (no scripts, no same-origin)
 * "Source" shows the code as text; a page over the size limit gets the download tile.
 */
const get = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn(), delete: vi.fn() }),
  fetchMe: async () => ({ user: { id: 'me' } }),
}));

const { FileViewer, fileKind } = await import('./FileViewer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE = '<!doctype html><html><body><h1>Report</h1><script>alert(1)</script></body></html>';
const fetchMock = vi.fn(async () => new Response(PAGE, { status: 200 }));
let root: Root | null = null;
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (path: string) =>
    path.startsWith('/items/') ? { data: [] } : { download_url: `https://files.test${path}` },
  );
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const render = async (file: ViewerFile) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(FileViewer, {
          accountId: 'acc',
          files: [file],
          source: { kind: 'update', itemId: 'item', updateId: 'upd', canRemove: false },
          onClose: vi.fn(),
        }),
      ),
    );
  });
  for (let i = 0; i < 4; i++) await settle();
};
const $ = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('HTML preview', () => {
  it('knows an HTML file by its type or its extension', () => {
    expect(fileKind({ name: 'report.html', mime: '' })).toBe('html');
    expect(fileKind({ name: 'page.htm', mime: 'application/octet-stream' })).toBe('html');
    expect(fileKind({ name: 'export', mime: 'text/html' })).toBe('html');
    expect(fileKind({ name: 'notes.txt', mime: 'text/plain' })).toBe('text');
  });

  it('shows the page in a sandboxed frame, and its code on "Source"', async () => {
    await render({ id: 'f1', name: 'report.html', size: PAGE.length, mime: 'text/html' });
    const frame = $('file-viewer-html') as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('srcdoc')).toBe(PAGE);
    const sandbox = frame!.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect($('file-viewer-text')).toBeNull();

    const source = [...document.querySelectorAll<HTMLElement>('[data-testid="file-viewer-html-mode"] button')].find(
      (b) => b.textContent === t('files.viewer.htmlSource'),
    );
    await act(async () => source!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect($('file-viewer-html')).toBeNull();
    expect($('file-viewer-text')?.textContent).toBe(PAGE);
  });

  it('offers a page over the size limit for download', async () => {
    await render({ id: 'f2', name: 'huge.html', size: 11 * 1024 * 1024, mime: 'text/html' });
    expect($('file-viewer-html')).toBeNull();
    expect($('file-viewer-tile')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
