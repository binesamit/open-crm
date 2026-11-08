// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../../../lib/api';
import type { BoardDetail } from '../board-api';

/** the default table's column order (shared / personal) — chosen with `board.update`, else shown. */
const patch = vi.fn().mockResolvedValue({});
vi.mock('../../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ patch }),
}));

const { MainTableOrderSetting } = await import('./MainTableOrderSetting');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  patch.mockClear();
});

const render = async (order: 'shared' | 'personal', canUpdate: boolean) => {
  const board = {
    id: 'b1',
    main_table_column_order: order,
    capabilities: { 'board.update': canUpdate },
  } as unknown as BoardDetail;
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MainTableOrderSetting, { accountId: 'acc', board }),
      ),
    );
  });
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('MainTableOrderSetting', () => {
  it('with board.update: a picker showing the current choice; picking the other saves it on the board', async () => {
    await render('shared', true);
    const picker = $('main-table-order-picker')!;
    expect(picker.textContent).toContain('משותף');
    await act(async () => picker.click());
    const personal = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')].find(
      (el) => el.textContent?.includes('אישי'),
    )!;
    await act(async () => personal.click());
    expect(patch).toHaveBeenCalledWith('/boards/b1', { main_table_column_order: 'personal' });
  });

  it('without it: the current choice as text, nothing to change', async () => {
    await render('personal', false);
    expect($('main-table-order-picker')).toBeNull();
    expect($('main-table-order-value')!.textContent).toContain('אישי');
  });
});
