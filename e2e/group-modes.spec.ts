// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, pickGroupColumn, signIn } from './helpers';

/**
 * Prod ק2: grouping options per column type in the group panel — numbers in ranges (in the column's
 * currency) or exact, a range size, a dropdown by its combinations, every status label.
 */
test('group modes: number ranges and size, dropdown combinations, every status label', async ({ page }) => {
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
  const board = await post('/boards', { name: `Group modes ${tag}`, workspace_id: ws });
  try {
    await post(`/boards/${board.id}/columns`, {
      id: 'amt',
      title: 'סכום',
      type: 'numbers',
      settings: { unit: { symbol: '₪', direction: 'left' }, thousands: true },
    });
    await post(`/boards/${board.id}/columns`, {
      id: 'dd',
      title: 'תגיות',
      type: 'dropdown',
      settings: {
        labels: [
          { id: 1, label: 'דחוף' },
          { id: 2, label: 'לקוח' },
        ],
      },
    });
    await post(`/boards/${board.id}/columns`, { id: 'st', title: 'מצב', type: 'status' });
    await post(`/boards/${board.id}/items`, { name: 'A', cells: { amt: 120, dd: { ids: [1, 2] }, st: { index: 1 } } });
    await post(`/boards/${board.id}/items`, { name: 'B', cells: { amt: 980, dd: { ids: [2] }, st: { index: 1 } } });

    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('toolbar-group').click();
    const sections = page.getByTestId('board-section');
    const keys = async (prefix: string) =>
      (await sections.evaluateAll((els) => els.map((e) => e.getAttribute('data-section') ?? ''))).map((k) =>
        k.slice(prefix.length + 1),
      );

    // Numbers: ranges by default, in the column's currency; a size of 1,000 puts both in one range; or exact.
    await pickGroupColumn(page, 'סכום');
    await expect(page.getByTestId('group-mode-ranges')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => keys('amt')).toEqual(['0', '800']);
    await expect(sections.first()).toContainText('₪0 – ₪200');
    await page.getByTestId('group-range-size').fill('1000');
    await expect.poll(() => keys('amt')).toEqual(['0']);
    await page.getByTestId('group-mode-exact').click();
    await expect.poll(() => keys('amt')).toEqual(['120', '980']);

    // A dropdown by the whole combination.
    await pickGroupColumn(page, 'תגיות');
    await page.getByTestId('group-mode-combo').click();
    // By name: "דחוף + לקוח" before "לקוח".
    await expect.poll(() => keys('dd')).toEqual(['combo:1|2', 'combo:2']);
    await expect(sections.first()).toContainText('דחוף + לקוח');

    // Status: every label, also those no item is on.
    await pickGroupColumn(page, 'מצב');
    const before = (await keys('st')).length;
    await page.getByTestId('group-panel').getByRole('checkbox', { name: 'להציג גם תוויות ריקות' }).click();
    await expect.poll(async () => (await keys('st')).length).toBeGreaterThan(before);
  } finally {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
