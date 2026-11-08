// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDetail, Item } from '../board-api';

vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => vi.fn(), useParams: () => ({}) }));

const { ComputedNameEditor } = await import('./ComputedNameEditor');
const { ComputedNameMark } = await import('../name-source/ComputedName');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** a computed name's click opens, in the row, the columns it is made of — and "open the item". */
const board = {
  id: 'b1',
  capabilities: {},
  columns: [
    {
      id: 'name',
      type: 'name',
      title: 'שם',
      settings: { name_source: { mode: 'template', template: '{client} – {note}' } },
    },
    { id: 'client', type: 'text', title: 'לקוח', settings: {}, read_only: false },
    { id: 'note', type: 'text', title: 'הערה', settings: {}, read_only: false },
    { id: 'other', type: 'text', title: 'אחר', settings: {}, read_only: false },
  ],
} as unknown as BoardDetail;
const item = {
  id: 'i1',
  name: 'Acme – first',
  cells: { client: { value: 'Acme', text: 'Acme' }, note: { value: 'first', text: 'first' } },
} as unknown as Item;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ComputedNameEditor', () => {
  it('lists the name’s source columns (only those) and opens the item from there', async () => {
    const onOpenItem = vi.fn();
    const rowClick = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(
            'div',
            { onClick: rowClick },
            createElement(ComputedNameEditor, {
              open: true,
              onClose: vi.fn(),
              item,
              board,
              members: [],
              accountId: 'acc',
              canEdit: true,
              onWrite: vi.fn(),
              onOpenItem,
              children: createElement('span', null, item.name),
            }),
          ),
        ),
      );
    });
    const fields = [...document.querySelectorAll('[data-testid="computed-name-field"]')];
    expect(fields.map((f) => f.firstElementChild!.textContent)).toEqual(['לקוח', 'הערה']);
    await act(async () => (document.querySelector('[data-testid="computed-name-open-item"]') as HTMLElement).click());
    expect(onOpenItem).toHaveBeenCalledOnce();
    // The row under it never sees the editor's clicks.
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('the ƒ mark with `edit` (the item card) shows the columns as editable cells, not links', async () => {
    const onWrite = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ComputedNameMark, {
            board,
            edit: { item, members: [], accountId: 'acc', canEdit: true, onWrite },
          }),
        ),
      );
    });
    await act(async () => (document.querySelector('[data-testid="computed-name-mark"]') as HTMLElement).click());
    const fields = [...document.querySelectorAll('[data-testid="computed-name-field"]')];
    expect(fields.map((f) => f.firstElementChild!.textContent)).toEqual(['לקוח', 'הערה']);
    // The old "scroll to the column" links are gone in this mode.
    expect(document.querySelector('[data-testid="computed-name-source"]')).toBeNull();
  });
});
