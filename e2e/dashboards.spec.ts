// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { addNew, forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * M8 ד4–ד5 — dashboards: created from the sidebar, sources picked in the UI, widgets added from the registry,
 * dragged and resized on the RTL grid (the layout survives a reload), read-only for a member of the workspace,
 * and refreshed live when a source board changes.
 */
const LIVE_MS = 8000;

/** A board with an Amount column and a Status column, and two items (through the API — the UI is not under test). */
const makeBoard = async (page: Page, name: string) => {
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name, workspace_id: ws } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'amount', title: 'סכום', type: 'numbers' },
  });
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: {
      id: 'stage',
      title: 'שלב',
      type: 'status',
      settings: {
        labels: [
          { id: 0, label: 'בעבודה', color: 'yellow', index: 0 },
          { id: 1, label: 'הושלם', color: 'forest', index: 1, is_done: true },
        ],
      },
    },
  });
  const items = [];
  for (const [n, amount, stage] of [
    ['ראשון', 100, 1],
    ['שני', 50, 0],
  ] as const) {
    items.push(
      (await (
        await page.request.post(`/api/v1/boards/${board.id}/items`, {
          headers,
          data: { name: n, cells: { amount, stage: { index: stage } } },
        })
      ).json()) as { id: string },
    );
  }
  return { id: board.id, items, headers };
};

const widget = (page: Page, type: string) => page.locator(`[data-testid="widget"][data-type="${type}"]`).first();
const cellOf = (page: Page, type: string) =>
  page
    .locator('[data-testid="dashboard-cell"]')
    .filter({ has: page.locator(`[data-type="${type}"]`) })
    .first();

test('build a dashboard: sources, widgets, drag and resize, live for a member', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardName = `מכירות ${Date.now().toString(36)}`;
  const board = await makeBoard(page, boardName);

  // "דשבורד חדש" next to "מסמך חדש": created at once, opened, listed in the tree.
  await addNew(page, 'add-new-dashboard');
  await page.waitForURL(/\/a\/demo\/dash\/[0-9A-Z]{26}$/);
  const dashboardId = page.url().split('/dash/')[1]!;
  await expect(page.getByTestId('dashboard-page')).toBeVisible();
  await expect(page.getByTestId('dashboard-empty')).toBeVisible();
  await expect(page.locator('[data-testid="dashboard-row"]').first()).toBeVisible();

  // Its boards, chosen in the UI.
  await page.getByTestId('dashboard-sources-open').click();
  await page.locator(`[data-testid="dashboard-source-option"][data-name="${boardName}"]`).check();
  await page.getByTestId('dashboard-sources-save').click();
  await expect(page.getByTestId('dashboard-board-count')).toContainText('1');

  // A numbers widget: the item count, then a sum of the Amount column through its settings.
  await page.getByTestId('dashboard-add-widget').click();
  await page.getByTestId('add-widget-numbers').click();
  await expect(widget(page, 'numbers').getByTestId('widget-number')).toHaveAttribute('data-value', '2');
  await widget(page, 'numbers').hover();
  await widget(page, 'numbers')
    .getByRole('button', { name: /^פעולות ל/ })
    .click();
  await page.getByTestId('widget-menu-settings').click();
  await page.getByTestId('widget-measure-fn').click();
  await page.getByRole('menuitemradio', { name: 'סכום' }).click();
  await page.getByTestId('widget-measure-column').click();
  await page.getByRole('menuitemradio', { name: /^סכום ·/ }).click();
  await page.getByTestId('widget-settings-save').click();
  await expect(widget(page, 'numbers').getByTestId('widget-number')).toHaveAttribute('data-value', '150');

  // A status battery and a chart from the registry (first settings come from the board's columns).
  await page.getByTestId('dashboard-add-widget').click();
  await page.getByTestId('add-widget-battery').click();
  await expect(widget(page, 'battery').getByTestId('battery-segment')).toHaveCount(2);
  await page.getByTestId('dashboard-add-widget').click();
  await page.getByTestId('add-widget-chart').click();
  await expect(widget(page, 'chart').getByTestId('widget-chart')).toBeVisible();

  // Drag the numbers widget by its handle towards the inline end (left in RTL): it moves along the columns.
  const numbersCell = cellOf(page, 'numbers');
  await expect(numbersCell).toHaveAttribute('data-x', '0');
  const handle = numbersCell.getByTestId('widget-move');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + 5, { steps: 8 });
  await page.mouse.move(box.x - 320, box.y + 5, { steps: 8 });
  await page.mouse.up();
  await expect(numbersCell).not.toHaveAttribute('data-x', '0');
  const movedX = await numbersCell.getAttribute('data-x');

  // Resize by the corner handle: wider.
  const width = Number(await numbersCell.getAttribute('data-w'));
  await numbersCell.hover();
  const corner = (await numbersCell.getByTestId('widget-resize').boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x - 120, corner.y + 90, { steps: 10 });
  // Reload only once the new layout reached the server (a reload aborts the request in flight).
  const saved = page.waitForResponse(
    (r) => /\/dashboards\/[^/]+\/layout$/.test(r.url()) && r.request().method() === 'PUT',
  );
  await page.mouse.up();
  await saved;
  await expect(numbersCell).not.toHaveAttribute('data-w', String(width));
  const resized = await numbersCell.getAttribute('data-w');

  // The layout is saved.
  await page.reload();
  await expect(cellOf(page, 'numbers')).toHaveAttribute('data-x', movedX!);
  await expect(cellOf(page, 'numbers')).toHaveAttribute('data-w', resized!);
  await expect(widget(page, 'chart').getByTestId('widget-chart')).toBeVisible();
  await page.screenshot({ path: 'e2e/screens/dashboards-build.png' });

  // A member of the workspace sees the main dashboard read-only, with the same numbers.
  const mate = await newTeammate(page, browser, 'צופה בדשבורד');
  forbidNativeDialogs(mate);
  await mate.goto(`/a/demo/dash/${dashboardId}`);
  await expect(widget(mate, 'numbers').getByTestId('widget-number')).toHaveAttribute('data-value', '150');
  await expect(mate.getByTestId('dashboard-add-widget')).toHaveCount(0);
  await expect(mate.getByTestId('widget-move')).toHaveCount(0);

  // Live: a change on the board reaches both dashboards without a reload.
  await page.request.put(`/api/v1/items/${board.items[1]!.id}/cells/amount`, {
    headers: board.headers,
    data: { value: 75 },
  });
  await expect(widget(page, 'numbers').getByTestId('widget-number')).toHaveAttribute('data-value', '175', {
    timeout: LIVE_MS,
  });
  await expect(widget(mate, 'numbers').getByTestId('widget-number')).toHaveAttribute('data-value', '175', {
    timeout: LIVE_MS,
  });
  await mate.context().close();
});

test('a private dashboard is not there for who is not invited; the time report widget', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = await makeBoard(page, `שעות ${Date.now().toString(36)}`);
  const dash = (await (
    await page.request.post(`/api/v1/workspaces/${ws}/dashboards`, {
      headers,
      data: { name: `פרטי ${Date.now().toString(36)}`, kind: 'private', board_ids: [board.id] },
    })
  ).json()) as { id: string };

  const mate = await newTeammate(page, browser, 'לא מוזמנת');
  forbidNativeDialogs(mate);
  await mate.goto(`/a/demo/dash/${dash.id}`);
  await expect(mate.getByTestId('dashboard-page-error')).toBeVisible();
  await mate.context().close();

  // Hours on the board show in a cross-board time report widget.
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'time', title: 'זמן', type: 'time_tracking' },
  });
  await page.request.post(`/api/v1/items/${board.items[0]!.id}/time/entries`, {
    headers,
    data: { column_id: 'time', started_at: new Date(Date.now() - 3 * 3600_000).toISOString(), duration_s: 5400 },
  });
  await page.goto(`/a/demo/dash/${dash.id}`);
  await page.getByTestId('dashboard-add-widget').click();
  await page.getByTestId('add-widget-time_report').click();
  await expect(widget(page, 'time_report').getByTestId('time-report-total')).toHaveAttribute('data-seconds', '5400');
});

test('drill-down: a value lists its items; an item opens over the dashboard', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = await makeBoard(page, `פירוט ${Date.now().toString(36)}`);
  const dash = (await (
    await page.request.post(`/api/v1/workspaces/${ws}/dashboards`, {
      headers,
      data: { name: `פירוט ${Date.now().toString(36)}`, board_ids: [board.id] },
    })
  ).json()) as { id: string };
  const add = (type: string, settings: Record<string, unknown>) =>
    page.request.post(`/api/v1/dashboards/${dash.id}/widgets`, { headers, data: { type, settings } });
  await add('numbers', {});
  await add('battery', { column: { type: 'status', title: 'שלב' } });
  await add('table', {});
  await page.goto(`/a/demo/dash/${dash.id}`);

  // The number lists every item; a click on one opens its card over the dashboard, and closing it stays here.
  await widget(page, 'numbers').getByTestId('widget-number').click();
  const panel = page.getByTestId('widget-drill-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('widget-drill-item')).toHaveCount(2);
  await panel.locator('[data-testid="widget-drill-item"][data-name="שני"]').click();
  await expect(page).toHaveURL(new RegExp(`/dash/${dash.id}/i/${board.id}/${board.items[1]!.id}`));
  await expect(page.getByTestId('item-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('item-card')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dash/${dash.id}$`));
  await page.getByTestId('widget-drill-close').click();
  await expect(panel).toHaveCount(0);

  // A battery segment lists the items with that label.
  await widget(page, 'battery').locator('[data-testid="battery-segment"][data-label="הושלם"]').click();
  await expect(panel.getByTestId('widget-drill-item')).toHaveCount(1);
  await expect(panel.getByTestId('widget-drill-item')).toHaveAttribute('data-name', 'ראשון');
  await page.getByTestId('widget-drill-close').click();

  // A table row opens the card here too (it used to go to the board).
  await widget(page, 'table').locator('[data-testid="widget-table-row"][data-name="ראשון"] a').click();
  await expect(page).toHaveURL(new RegExp(`/dash/${dash.id}/i/${board.id}/${board.items[0]!.id}`));
  await expect(page.getByTestId('item-card')).toBeVisible();
});
