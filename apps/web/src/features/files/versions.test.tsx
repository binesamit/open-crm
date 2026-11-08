// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@bines/shared';
import type * as ApiModule from '../../lib/api';
import type { FileSource } from './FileViewer';
import type { FileVersion } from './versions';

/**
 * File versions: the viewer's "Versions" tab lists a cell file's versions newest first, the current
 * one marked; each row's menu offers what the rules allow; an older version shows with a bar over the preview,
 * which makes it current; deleting asks first; an update's files have no versions.
 */
const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post, delete: del }),
  fetchMe: async () => ({ user: { id: ME } }),
}));
const confirmDialog = vi.fn(async (_opts: { title: string; message?: string }) => true);
vi.mock('../../lib/dialogs', () => ({ confirmDialog: (o: { title: string }) => confirmDialog(o) }));
const toasts: { message: string }[] = [];
vi.mock('../../lib/toast', () => ({ showToast: (o: { message: string }) => toasts.push(o) }));

const { FileViewer } = await import('./FileViewer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number) => `01HFAKE0${String(n).padStart(18, '0')}`;
const ME = id(900);
const OTHER = id(901);
const ROOT = id(1);
const version = (n: number, by: string, current = false): FileVersion => ({
  id: n === 1 ? ROOT : id(n),
  version: n,
  name: 'garden.jpg',
  size: n * 1000,
  mime: 'image/jpeg',
  created_by: { id: by, name: by === ME ? 'Me' : 'Other' },
  created_at: new Date(Date.now() - n * 60_000).toISOString(),
  current,
});

let versions: FileVersion[] = [];
let boardAdmin = false;
let root: Root | null = null;
beforeEach(() => {
  versions = [version(3, ME, true), version(2, OTHER), version(1, ME)];
  boardAdmin = false;
  toasts.length = 0;
  confirmDialog.mockClear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === `/files/${ROOT}/versions`) return { data: versions };
    if (path.startsWith('/boards/')) return { capabilities: { 'board.update': boardAdmin } };
    if (path.startsWith('/items/')) return { data: [] };
    return { download_url: `https://files.test${path}` };
  });
  del.mockResolvedValue({ ok: true });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const cell: FileSource = { kind: 'cell', itemId: id(50), columnId: 'files', boardId: id(60), canRemove: true };
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const render = async (source: FileSource = cell) => {
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
          files: [{ id: ROOT, name: 'garden.jpg', size: 3000, mime: 'image/jpeg' }],
          source,
          onClose: vi.fn(),
        }),
      ),
    );
  });
  await settle();
  await settle();
};
const $ = (testId: string, within: ParentNode = document) =>
  within.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
  await settle();
};
const openVersions = () => click($('file-viewer-versions'));
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="version-row-"]')];
/** The ids of the menu items a version's ⋯ offers. */
const menuOf = async (n: number) => {
  await click($('version-menu', $(`version-row-${n}`)!));
  const ids = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((b) => b.dataset.testid);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  return ids;
};

describe('file versions in the viewer', () => {
  it('the header button opens the tab: newest first, the current one marked, its number in the header', async () => {
    await render();
    expect($('file-viewer-versions')!.textContent).toContain('3');
    expect($('file-viewer-version')!.textContent).toBe(t('files.versions.version', { n: 3 }));
    expect($('versions-panel')).toBeNull();
    await openVersions();
    expect($('versions-panel')).not.toBeNull();
    expect($('file-viewer-versions')!.getAttribute('aria-pressed')).toBe('true');
    expect($('versions-tab')!.getAttribute('aria-selected')).toBe('true');
    expect(rows().map((r) => r.dataset.testid)).toEqual(['version-row-3', 'version-row-2', 'version-row-1']);
    expect(rows().map((r) => !!$('version-current', r))).toEqual([true, false, false]);
    expect($('version-current')!.textContent).toBe(t('files.versions.current'));
    expect($('versions-upload')).not.toBeNull();
    // The button toggles back to the comments.
    await openVersions();
    expect($('versions-panel')).toBeNull();
  });

  it('menus follow the rules: current = download only; delete only for its uploader (or a board admin), never v1', async () => {
    await render();
    await openVersions();
    expect(await menuOf(3)).toEqual(['version-download']);
    expect(await menuOf(2)).toEqual(['version-download', 'version-make-current']);
    expect(await menuOf(1)).toEqual(['version-download', 'version-make-current']);
    versions = [version(3, ME, true), version(2, ME), version(1, ME)];
    await act(async () => root!.unmount());
    await render();
    await openVersions();
    expect(await menuOf(2)).toEqual(['version-download', 'version-make-current', 'version-delete']);
  });

  it('a board admin may delete anyone’s version', async () => {
    boardAdmin = true;
    await render();
    await openVersions();
    expect(await menuOf(2)).toEqual(['version-download', 'version-make-current', 'version-delete']);
  });

  it('read-only: the list and downloads, nothing that changes the file', async () => {
    await render({ ...cell, canRemove: false });
    await openVersions();
    expect($('versions-upload')).toBeNull();
    expect(await menuOf(2)).toEqual(['version-download']);
  });

  it('an older version shows with the bar; download takes it; "make current" shows the new current one', async () => {
    await render();
    await openVersions();
    await click(rows()[2]!.querySelector('button'));
    const bar = $('old-version-bar')!;
    expect(bar.textContent).toContain(t('files.versions.oldBar', { n: 1, total: 3 }));
    expect($('file-viewer-version')!.textContent).toBe(t('files.versions.versionOf', { n: 1, total: 3 }));
    expect($('version-row-1')!.dataset.selected).toBe('true');
    // Version 1's id is the file's: `exact` asks for its own bytes, not the current version's.
    expect($('file-viewer-image')!.getAttribute('src')).toBe(`https://files.test/files/${ROOT}?inline=1&exact=1`);

    // Back to the current one, then to v2: its own id is previewed and downloaded.
    await click($('old-version-back'));
    expect($('old-version-bar')).toBeNull();
    await click(rows()[1]!.querySelector('button'));
    expect($('file-viewer-image')!.getAttribute('src')).toBe(`https://files.test/files/${id(2)}?inline=1&exact=1`);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await click($('file-viewer-download'));
    expect(get).toHaveBeenCalledWith(`/files/${id(2)}?exact=1`);

    post.mockImplementation(async () => {
      versions = [version(4, ME, true), ...versions.map((v) => ({ ...v, current: false }))];
      return versions[0];
    });
    await click($('old-version-make-current'));
    expect(post).toHaveBeenCalledWith(`/files/${ROOT}/versions/${id(2)}/make-current`);
    expect($('old-version-bar')).toBeNull();
    expect(rows()[0]!.dataset.testid).toBe('version-row-4');
    expect($('file-viewer-version')!.textContent).toBe(t('files.versions.version', { n: 4 }));
  });

  it('"version N of M" counts the versions there are (one deleted: 1 of 2)', async () => {
    versions = [version(3, ME, true), version(1, ME)];
    await render();
    await openVersions();
    await click(rows()[1]!.querySelector('button'));
    expect($('old-version-bar')!.textContent).toContain(t('files.versions.oldBar', { n: 1, total: 2 }));
    expect($('file-viewer-version')!.textContent).toBe(t('files.versions.versionOf', { n: 1, total: 2 }));
  });

  it('delete asks first, then deletes; a refusal shows the server’s reason', async () => {
    versions = [version(3, ME, true), version(2, ME), version(1, ME)];
    await render();
    await openVersions();
    await click($('version-menu', $('version-row-2')!));
    await click($('version-delete'));
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: t('files.versions.deleteTitle', { n: 2 }) }),
    );
    expect(del).toHaveBeenCalledWith(`/files/${ROOT}/versions/${id(2)}`);

    const { ApiError } = await import('@bines/sdk');
    del.mockRejectedValueOnce(
      new ApiError(403, { code: 'forbidden', message: 'version_owner_or_board_admin', request_id: 'r' }),
    );
    await click($('version-menu', $('version-row-2')!));
    await click($('version-delete'));
    expect(toasts.at(-1)?.message).toBe(t('error.version_owner_or_board_admin'));
  });

  it('removing the file from the cell says it goes to the trash with its versions', async () => {
    await render();
    await click($('file-viewer-remove'));
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ message: t('files.viewer.removeToTrash') }));
  });

  it('an update’s files have no versions', async () => {
    await render({ kind: 'update', itemId: id(50), updateId: id(70), canRemove: true });
    expect($('file-viewer-versions')).toBeNull();
    expect($('versions-tab')).toBeNull();
    expect($('file-viewer-version')).toBeNull();
    expect(get).not.toHaveBeenCalledWith(`/files/${ROOT}/versions`);
  });
});
