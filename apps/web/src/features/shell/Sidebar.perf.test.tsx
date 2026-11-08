// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyAccount, WorkspaceTree } from '@bines/shared';
import type * as UiModule from '@bines/ui';
import type * as ApiModule from '../../lib/api';

/**
 * s4f-side: the sidebar of a big workspace (~1,200 boards, docs, dashboards and folders). Rows are memoised, so
 * adding / renaming one board re-renders about one row, not the whole tree. Every row is rendered (windowing only
 * starts above 1,500 lines); a windowed tree is tested with the threshold lowered (localStorage override).
 *
 * Rows are counted by their ⋯ trigger (every board, doc, dashboard and folder row renders one), timings by the wall
 * clock around React's commit (happy-dom: no layout, the scroll box is stubbed to 800 px).
 */
// Rendering ~1,200 rows takes seconds when the whole web suite runs in parallel; the default 5 s is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const counter = vi.hoisted(() => ({ triggers: 0, renderMs: 0 }));
const WORKSPACE_NAME = 'Big workspace';
vi.mock('@bines/ui', async (orig) => {
  const ui = await orig<typeof UiModule>();
  return {
    ...ui,
    MenuTrigger: (p: Parameters<typeof ui.MenuTrigger>[0]) => {
      // The workspace's own ⋯ (on the switcher) is not a row.
      if (!p.label.includes(WORKSPACE_NAME)) counter.triggers++;
      return ui.MenuTrigger(p);
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, params: _params, ...rest }: { children?: ReactNode; to: string; params: unknown }) =>
    createElement('a', rest, children),
  useParams: () => ({}),
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock('../../lib/realtime', () => ({ useEventStream: () => undefined }));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({
    get: () => new Promise(() => undefined),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }),
}));

const { Sidebar } = await import('./Sidebar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = { id: 'A', slug: 'acme', name: 'Acme', role: 'admin', plan_features: null } as unknown as MyAccount;
const W = 'W1';
const pos = (i: number) => `a${String(i).padStart(5, '0')}`;

/** 60 folders (40 top, 20 nested), 840 boards, 240 docs, 60 dashboards = 1,200 entries. */
const bigTree = (): WorkspaceTree => {
  const folders: WorkspaceTree['folders'] = [];
  for (let i = 0; i < 40; i++)
    folders.push({
      id: `F${i}`,
      workspace_id: W,
      parent_folder_id: null,
      name: `Folder ${i}`,
      color: null,
      position: pos(i),
      can_edit: true,
    });
  for (let i = 0; i < 20; i++)
    folders.push({
      id: `S${i}`,
      workspace_id: W,
      parent_folder_id: `F${i}`,
      name: `Sub ${i}`,
      color: null,
      position: pos(i),
      can_edit: true,
    });
  const place = (i: number) => (i % 4 === 0 ? null : i % 4 === 1 ? `S${i % 20}` : `F${i % 40}`);
  const boards: WorkspaceTree['boards'] = Array.from({ length: 840 }, (_, i) => ({
    id: `B${i}`,
    name: `Board ${i}`,
    kind: 'main' as const,
    workspace_id: W,
    folder_id: place(i),
    position: pos(i),
    item_terminology: 'item',
    can_update: true,
    can_delete: true,
  }));
  const entities: WorkspaceTree['entities'] = Array.from({ length: 300 }, (_, i) => ({
    type: i < 240 ? ('doc' as const) : ('dashboard' as const),
    id: `E${i}`,
    name: `${i < 240 ? 'Doc' : 'Dash'} ${i}`,
    icon: null,
    kind: 'main' as const,
    folder_id: place(i + 1),
    position: pos(1000 + i),
    can_update: true,
    can_delete: true,
  }));
  return {
    workspace: {
      id: W,
      name: WORKSPACE_NAME,
      kind: 'open',
      position: 'a',
      can_edit: true,
      can_delete: true,
      can_create: true,
    },
    folders,
    boards,
    entities,
  };
};

const treeKey = ['account', 'A', 'tree', W];
let root: Root | null = null;
let host: HTMLDivElement;
let qc: QueryClient;
const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');

beforeAll(() => {
  // The sidebar's scroll box is 800 px tall (happy-dom lays nothing out).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.sidebarScroll !== undefined ? 800 : 0;
    },
  });
  // …holding a tall tree (the virtualiser clamps a scroll to it).
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset?.sidebarScroll !== undefined ? 100_000 : 0;
    },
  });
});
afterAll(() => {
  if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
  if (scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeight);
});
beforeEach(() => {
  counter.triggers = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['account', 'A', 'workspaces'], {
    data: [{ id: W, name: WORKSPACE_NAME, kind: 'open', position: 'a' }],
  });
  qc.setQueryData(treeKey, bigTree());
  qc.setQueryData(['account', 'A', 'favorites'], { data: [] });
  qc.setQueryData(['account', 'A', 'favorite-docs'], { data: [] });
  qc.setQueryData(['me', 'accounts'], { data: [ACCOUNT] });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const mount = () => {
  counter.renderMs = 0;
  const t0 = performance.now();
  act(() => {
    root = createRoot(host);
    root.render(
      createElement(
        Profiler,
        { id: 'sidebar', onRender: (_id: string, _phase: string, ms: number) => (counter.renderMs += ms) },
        createElement(QueryClientProvider, { client: qc }, createElement(Sidebar, { account: ACCOUNT })),
      ),
    );
  });
  return { ms: performance.now() - t0, renderMs: counter.renderMs };
};

const rowsInDom = () =>
  host.querySelectorAll(
    '[data-testid="board-row"],[data-testid="doc-row"],[data-testid="dashboard-row"],[data-testid="folder-row"]',
  ).length;

/** Applies a change to the cached tree the way a refetch lands (setData: structural sharing) and counts row renders. */
const change = async (fn: (t: WorkspaceTree) => WorkspaceTree) => {
  counter.triggers = 0;
  counter.renderMs = 0;
  const t0 = performance.now();
  // React Query tells its observers on the next tick: wait for that inside act.
  await act(async () => {
    qc.setQueryData<WorkspaceTree>(treeKey, (old) => fn(old!));
    await new Promise((r) => setTimeout(r, 0));
  });
  return { renders: counter.triggers, ms: performance.now() - t0, renderMs: counter.renderMs };
};

const NEW_BOARD = {
  id: 'NEW',
  name: 'New board',
  kind: 'main' as const,
  workspace_id: W,
  folder_id: 'F0',
  position: 'a0000z',
  item_terminology: 'item',
  can_update: true,
  can_delete: true,
};

describe('sidebar with ~1,200 entries, not windowed (s4f-side)', () => {
  it('first render: every row', () => {
    const { ms, renderMs } = mount();
    const mounted = rowsInDom();
    console.warn(
      `[s4f-side] full: initial render ${ms.toFixed(0)} ms wall, ${renderMs.toFixed(0)} ms React render, ${mounted} rows in the DOM`,
    );
    expect(mounted).toBe(1200);
  });

  it('a new board re-renders about one row', async () => {
    mount();
    const res = await change((t) => ({ ...t, boards: [...t.boards, NEW_BOARD] }));
    console.warn(
      `[s4f-side] full: add one board ${res.renders} row renders, ${res.ms.toFixed(0)} ms wall, ${res.renderMs.toFixed(0)} ms React render`,
    );
    expect(host.querySelector('[data-testid="board-row"][data-name="New board"]')).not.toBeNull();
    expect(res.renders).toBeLessThanOrEqual(3);
  });

  it('a renamed board re-renders that row only', async () => {
    mount();
    const res = await change((t) => ({
      ...t,
      boards: t.boards.map((b) => (b.id === 'B1' ? { ...b, name: 'Renamed' } : b)),
    }));
    console.warn(
      `[s4f-side] full: rename one board ${res.renders} row renders, ${res.ms.toFixed(0)} ms wall, ${res.renderMs.toFixed(0)} ms React render`,
    );
    expect(host.querySelector('[data-testid="board-row"][data-name="Renamed"]')).not.toBeNull();
    expect(res.renders).toBeLessThanOrEqual(1);
  });

  it('a board moved to another folder shows there, re-rendering about that row', async () => {
    mount();
    const res = await change((t) => ({
      ...t,
      boards: t.boards.map((b) => (b.id === 'B1' ? { ...b, folder_id: 'F39' } : b)),
    }));
    const b1 = host.querySelector('[data-testid="board-row"][data-name="Board 1"]')!;
    const f39 = [...host.querySelectorAll('[data-testid="folder-row"]')].find((f) =>
      f.textContent?.includes('Folder 39'),
    )!;
    expect(f39.parentElement!.contains(b1)).toBe(true);
    expect(res.renders).toBeLessThanOrEqual(3);
  });
});

describe('sidebar with ~1,200 entries, windowed (threshold lowered to 100)', () => {
  const scrollTo = vi.fn();
  const original = HTMLElement.prototype.scrollTo;
  beforeEach(() => {
    localStorage.setItem('bines:sidebar-window-rows', '100');
    scrollTo.mockReset();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof original;
  });
  afterEach(() => {
    localStorage.removeItem('bines:sidebar-window-rows');
    HTMLElement.prototype.scrollTo = original;
  });

  it('mounts a window of rows, nested as the tree is', () => {
    const { ms, renderMs } = mount();
    const mounted = rowsInDom();
    console.warn(
      `[s4f-side] windowed: initial render ${ms.toFixed(0)} ms wall, ${renderMs.toFixed(0)} ms React render, ${mounted} rows in the DOM`,
    );
    expect(mounted).toBeGreaterThan(10);
    expect(mounted).toBeLessThan(200);
    // B1 is in F1 / S1, two folders deep.
    const b1 = host.querySelector('[data-testid="board-row"][data-name="Board 1"]')!;
    expect(b1.parentElement?.dataset.testid).toBe('folder-children');
    expect(b1.parentElement?.dataset.depth).toBe('2');
    expect(b1.closest('[data-testid="folder-children"][data-depth="1"]')).not.toBeNull();
  });

  it('a new board far down the tree is scrolled into view', async () => {
    mount();
    expect(host.querySelector('[data-name="Last board"]')).toBeNull();
    await change((t) => ({
      ...t,
      boards: [...t.boards, { ...NEW_BOARD, id: 'LAST', name: 'Last board', folder_id: 'F30', position: 'z' }],
    }));
    const tops = scrollTo.mock.calls.map((c) => (c[0] as ScrollToOptions).top ?? 0);
    expect(Math.max(0, ...tops)).toBeGreaterThan(10_000);
  });
});

describe('a small workspace renders every row, nested as before (s4f-side)', () => {
  it('folders hold their rows; rows without a folder are in the root zone', () => {
    const small = bigTree();
    small.folders = small.folders.slice(0, 2);
    small.boards = [
      { ...small.boards[2]!, id: 'in', name: 'Inside', folder_id: 'F0' },
      { ...small.boards[0]!, id: 'out', name: 'Outside', folder_id: null },
    ];
    small.entities = [];
    qc.setQueryData(treeKey, small);
    mount();
    expect(rowsInDom()).toBe(4);
    const inside = host.querySelector('[data-testid="board-row"][data-name="Inside"]')!;
    expect(inside.parentElement?.dataset.testid).toBe('folder-children');
    const folder = [...host.querySelectorAll('[data-testid="folder-row"]')].find((f) =>
      f.textContent?.includes('Folder 0'),
    )!;
    expect(folder.parentElement!.querySelector('[data-name="Inside"]')).toBe(inside);
    const outside = host.querySelector('[data-testid="board-row"][data-name="Outside"]')!;
    expect(outside.closest('[data-testid="folder-children"]')).toBeNull();
    // Rows 2 px apart, as `space-y-0.5` had them.
    expect(folder.parentElement!.nextElementSibling?.className).toContain('mt-0.5');
  });
});
