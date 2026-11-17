// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, pickGroupColumn, signIn } from './helpers';

/**
 * Prod (ק1): grouping by a date — "when" by default (overdue, today, tomorrow …), or exact day / week /
 * month / quarter / year from the group panel; saved in the view.
 */
test('group by a date: when by default, then month / quarter / year — kept after a reload', async ({ page }) => {
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
  const board = await post('/boards', { name: `Group dates ${tag}`, workspace_id: ws });
  try {
    await post(`/boards/${board.id}/columns`, { id: 'due', title: 'מועד', type: 'date' });
    await post(`/boards/${board.id}/items`, { name: 'Old', cells: { due: { date: '2020-03-10' } } });
    await post(`/boards/${board.id}/items`, { name: 'Far', cells: { due: { date: '2099-11-20' } } });
    await post(`/boards/${board.id}/items`, { name: 'None' });

    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('toolbar-group').click();
    await pickGroupColumn(page, 'מועד');
    const sections = page.getByTestId('board-section');
    const keys = async () =>
      (await sections.evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))).map((k) =>
        k?.slice('due:'.length),
      );

    // "When" is the default: overdue, later, then no date.
    await expect(page.getByTestId('group-unit-when')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(keys).toEqual(['overdue', 'later', '__empty__']);
    await expect(sections.first()).toContainText('באיחור');

    await page.getByTestId('group-unit-month').click();
    await expect(page.getByTestId('group-unit-hint')).toHaveText('חודש ושנה');
    await expect.poll(keys).toEqual(['2020-03', '2099-11', '__empty__']);
    await page.getByTestId('group-unit-quarter').click();
    await expect.poll(keys).toEqual(['2020-Q1', '2099-Q4', '__empty__']);
    await expect(sections.first()).toContainText('רבעון 1 · 2020');
    await page.getByTestId('group-unit-year').click();
    await expect.poll(keys).toEqual(['2020', '2099', '__empty__']);

    // Saved in the view.
    await page.keyboard.press('Escape');
    await page.reload();
    await expect.poll(keys).toEqual(['2020', '2099', '__empty__']);
  } finally {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
