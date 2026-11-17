// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * a mirror's group footer offers its source column's summaries — a mirror of a currency sums as
 * currency and can show the average; a mirror of a status shows the battery — not only "filled".
 */
test('a mirror footer: sum and average in the source currency; a status mirror as a battery', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const api = (path: string) => `/api/v1${path}`;
  const post = async (path: string, data: unknown) => {
    const res = await page.request.post(api(path), { headers, data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()) as { id: string };
  };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const deals = await post('/boards', { name: `Mirror deals ${tag}`, workspace_id: ws });
  const clients = await post('/boards', { name: `Mirror clients ${tag}`, workspace_id: ws });
  try {
    await post(`/boards/${deals.id}/columns`, {
      id: 'amount',
      title: 'סכום',
      type: 'numbers',
      settings: { unit: { symbol: '₪', direction: 'left' }, thousands: true },
    });
    await post(`/boards/${deals.id}/columns`, { id: 'stage', title: 'שלב', type: 'status' });
    const a = await post(`/boards/${deals.id}/items`, { name: 'A', cells: { amount: 1200, stage: { index: 1 } } });
    const b = await post(`/boards/${deals.id}/items`, { name: 'B', cells: { amount: 300, stage: { index: 1 } } });
    await post(`/boards/${clients.id}/columns`, {
      id: 'rel',
      title: 'עסקאות',
      type: 'board_relation',
      settings: { board_ids: [deals.id], allow_multiple: true },
    });
    await post(`/boards/${clients.id}/columns`, {
      id: 'total',
      title: 'סה"כ עסקאות',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'amount' },
    });
    await post(`/boards/${clients.id}/columns`, {
      id: 'stages',
      title: 'שלבים',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'stage' },
    });
    await post(`/boards/${clients.id}/items`, { name: 'X', cells: { rel: { item_ids: [a.id] } } });
    await post(`/boards/${clients.id}/items`, { name: 'Y', cells: { rel: { item_ids: [b.id] } } });

    await page.goto(`/a/demo/b/${clients.id}`);
    const footer = page.getByTestId('summary-row').first();
    const total = footer.locator('[data-summary="total"]');
    await expect(total).toContainText('₪1,500');
    await expect(footer.locator('[data-summary="stages"]').getByTestId('battery-segment').first()).toBeVisible();

    // The footer menu offers the numbers' calculations; the average keeps the currency.
    await total.click();
    await page.getByRole('menu').getByText('ממוצע', { exact: true }).click();
    await expect(total).toContainText('₪750');
  } finally {
    await page.request.delete(api(`/boards/${clients.id}`), { headers });
    await page.request.delete(api(`/boards/${deals.id}`), { headers });
  }
});
