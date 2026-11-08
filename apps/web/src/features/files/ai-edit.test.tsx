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
 * "Ask the AI for a change" in the viewer's "Versions" tab: shown for an image the person may change
 * when the server says AI is available; the instruction goes for the version shown (an older one by `version_id`);
 * busy while the AI works (the focus stays in the box); the new version becomes the one shown; a refusal shows the
 * server's reason in the box.
 */
const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post, delete: vi.fn() }),
  fetchMe: async () => ({ user: { id: ME } }),
}));
const toasts: { message: string }[] = [];
vi.mock('../../lib/toast', () => ({ showToast: (o: { message: string }) => toasts.push(o) }));

const { FileViewer } = await import('./FileViewer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number) => `01HFAKE1${String(n).padStart(18, '0')}`;
const ME = id(900);
const ROOT = id(1);
const version = (n: number, current = false, mime = 'image/png'): FileVersion => ({
  id: n === 1 ? ROOT : id(n),
  version: n,
  name: 'poster.png',
  size: n * 1000,
  mime,
  created_by: { id: ME, name: 'Me' },
  created_at: new Date(Date.now() - n * 60_000).toISOString(),
  current,
});

let versions: FileVersion[] = [];
let status: { available: boolean; reason: string | null } = { available: true, reason: null };
let root: Root | null = null;
beforeEach(() => {
  versions = [version(2, true), version(1)];
  status = { available: true, reason: null };
  toasts.length = 0;
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === `/files/${ROOT}/versions`) return { data: versions };
    if (path === `/files/${ROOT}/ai-edit`) return status;
    if (path.startsWith('/boards/')) return { capabilities: { 'board.update': false } };
    if (path.startsWith('/items/')) return { data: [] };
    return { download_url: `https://files.test${path}` };
  });
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
          files: [{ id: ROOT, name: 'poster.png', size: 2000, mime: 'image/png' }],
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
const type = async (value: string) => {
  const box = $('ai-edit-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ask the AI for a change', () => {
  it('sends the instruction for the current version; busy while it works; then shows the new current version', async () => {
    await render();
    await openVersions();
    expect($('ai-edit')).not.toBeNull();
    expect($('ai-edit-hint')!.textContent).toContain(t('files.aiEdit.fromCurrent', { n: 2 }));
    expect($('ai-edit-hint')!.textContent).toContain(t('files.aiEdit.cost'));
    // Nothing to send yet.
    expect(($('ai-edit-submit') as HTMLButtonElement).disabled).toBe(true);

    let finish: (v: FileVersion) => void = () => undefined;
    post.mockImplementation(
      () =>
        new Promise<FileVersion>((resolve) => {
          finish = resolve;
        }),
    );
    await type('Remove the background');
    await click($('ai-edit-submit'));
    expect(post).toHaveBeenCalledWith(`/files/${ROOT}/ai-edit`, { instruction: 'Remove the background' });
    // Busy: the hint says the AI is working, the button waits, the focus stays in the box (not on <body>).
    expect($('ai-edit')!.getAttribute('aria-busy')).toBe('true');
    expect($('ai-edit-hint')!.textContent).toBe(t('files.aiEdit.busy'));
    expect(($('ai-edit-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe($('ai-edit-input'));

    const v3 = version(3, true);
    versions = [v3, ...versions.map((v) => ({ ...v, current: false }))];
    await act(async () => finish(v3));
    await settle();
    await settle();
    expect($('ai-edit')!.getAttribute('aria-busy')).toBeNull();
    expect(($('ai-edit-input') as HTMLTextAreaElement).value).toBe('');
    expect(toasts.at(-1)?.message).toBe(t('files.aiEdit.done', { n: 3 }));
    expect($('file-viewer-version')!.textContent).toBe(t('files.versions.version', { n: 3 }));
    expect($('versions-list')!.firstElementChild!.getAttribute('data-testid')).toBe('version-row-3');
  });

  it('an older version being viewed is the one changed (version_id); afterwards the new current one shows', async () => {
    await render();
    await openVersions();
    await click($('version-row-1')!.querySelector('button'));
    expect($('old-version-bar')).not.toBeNull();
    expect($('ai-edit-hint')!.textContent).toContain(t('files.aiEdit.fromOld', { n: 1 }));
    post.mockImplementation(async () => {
      versions = [version(3, true), ...versions.map((v) => ({ ...v, current: false }))];
      return versions[0];
    });
    await type('Make it blue');
    await click($('ai-edit-submit'));
    expect(post).toHaveBeenCalledWith(`/files/${ROOT}/ai-edit`, { instruction: 'Make it blue', version_id: ROOT });
    expect($('old-version-bar')).toBeNull();
    expect($('file-viewer-version')!.textContent).toBe(t('files.versions.version', { n: 3 }));
  });

  it("a refusal shows the server's reason in the box and keeps the instruction", async () => {
    const { ApiError } = await import('@bines/sdk');
    post.mockRejectedValueOnce(
      new ApiError(422, { code: 'unprocessable', message: 'ai_model_no_image_edit', request_id: 'r' }),
    );
    await render();
    await openVersions();
    await type('Bigger');
    await click($('ai-edit-submit'));
    expect($('ai-edit-error')!.textContent).toBe(t('error.ai_model_no_image_edit'));
    expect(($('ai-edit-input') as HTMLTextAreaElement).value).toBe('Bigger');
  });

  it('hidden when AI is not available, for a file that is not an image, and without the right to change it', async () => {
    status = { available: false, reason: 'ai_disabled' };
    await render();
    await openVersions();
    expect($('versions-panel')).not.toBeNull();
    expect($('ai-edit')).toBeNull();
    act(() => root!.unmount());

    status = { available: true, reason: null };
    versions = [version(2, true, 'application/pdf'), version(1)];
    await render();
    await openVersions();
    expect($('ai-edit')).toBeNull();
    act(() => root!.unmount());

    versions = [version(2, true), version(1)];
    get.mockClear();
    await render({ ...cell, canRemove: false });
    await openVersions();
    expect($('ai-edit')).toBeNull();
    expect(get).not.toHaveBeenCalledWith(`/files/${ROOT}/ai-edit`);
  });
});
