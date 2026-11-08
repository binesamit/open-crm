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
 * a relation column over several boards — chips pick the board to browse ("הכל" first), the items
 * show under their board's name and its groups; one board browsed pages with "load more".
 */
const get = vi.fn();
vi.mock('../../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), Link: () => null }));

const { RelationCell } = await import('./RelationCell');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boards: Record<string, unknown> = {
  b1: {
    id: 'b1',
    name: 'לקוחות',
    capabilities: {},
    columns: [],
    groups: [
      { id: 'g1', title: 'פעילים', color: 'green' },
      { id: 'g2', title: 'ארכיון', color: 'grey' },
    ],
  },
  b2: {
    id: 'b2',
    name: 'פרויקטים',
    capabilities: {},
    columns: [],
    groups: [{ id: 'p1', title: 'בעבודה', color: 'blue' }],
  },
};
const search: Record<string, unknown[]> = {
  b1: [
    { id: 'a', name: 'אביב מור', board_id: 'b1', group_id: 'g2' },
    { id: 'b', name: 'בועז שובל', board_id: 'b1', group_id: 'g1' },
  ],
  b2: [{ id: 'p', name: 'Acme Projects', board_id: 'b2', group_id: 'p1' }],
};

let root: Root | null = null;
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    const m = /^\/boards\/(\w+)(\/items\/search\?q=[^&]*(?:&offset=(\d+))?)?/.exec(path);
    if (!m) return {};
    if (!m[2]) return boards[m[1]!];
    const offset = Number(m[3] ?? 0);
    return {
      data: offset ? [{ id: 'z', name: 'page two', board_id: m[1], group_id: null }] : search[m[1]!],
      filter: null,
      next_offset: m[1] === 'b1' && !offset ? 30 : null,
    };
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const render = async (settings: Record<string, unknown> = {}) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const column = {
    id: 'rel',
    type: 'board_relation',
    title: 'לקוח / פרויקט',
    settings: { board_ids: ['b1', 'b2'], ...settings },
  } as unknown as Column;
  const props = {
    column,
    value: null,
    text: null,
    editable: true,
    accountId: 'acc',
    itemId: 'i1',
    boardId: 'src',
    members: [],
    onChange: vi.fn(),
  } as unknown as CellProps;
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RelationCell, props)));
  });
  await act(async () => (host.firstElementChild as HTMLElement).click());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
};
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
};

describe('relation picker over several boards', () => {
  it('lists the items under each board and its groups, in order', async () => {
    await render();
    expect(all('relation-board-chip').map((c) => c.textContent)).toEqual(['הכל', 'לקוחות', 'פרויקטים']);
    expect(all('relation-board-header').map((h) => h.textContent)).toEqual(['לקוחות', 'פרויקטים']);
    expect(all('relation-group-header').map((h) => h.textContent)).toEqual(['פעילים', 'ארכיון', 'בעבודה']);
    const names = [...document.querySelectorAll('[role="listbox"] label')].map((l) => l.textContent);
    expect(names).toEqual(['בועז שובל', 'אביב מור', 'Acme Projects']);
  });

  it('a chip browses one board, and that board loads more', async () => {
    await render();
    await click(all('relation-board-chip')[1]!);
    expect(all('relation-board-chip')[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(all('relation-board-header')).toHaveLength(0);
    let names = [...document.querySelectorAll('[role="listbox"] label')].map((l) => l.textContent);
    expect(names).toEqual(['בועז שובל', 'אביב מור']);
    await click(document.querySelector<HTMLElement>('[data-testid="relation-load-more"]')!);
    expect(get).toHaveBeenCalledWith('/boards/b1/items/search?q=&offset=30');
    names = [...document.querySelectorAll('[role="listbox"] label')].map((l) => l.textContent);
    expect(names).toContain('page two');
  });

  it('"one list" keeps the board name beside each item', async () => {
    await render({ picker_group_by: 'none' });
    expect(all('relation-board-header')).toHaveLength(0);
    expect(all('relation-group-header')).toHaveLength(0);
    expect(document.querySelector('[role="listbox"]')!.textContent).toContain('לקוחות');
  });
});
