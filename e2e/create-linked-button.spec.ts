// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * P1-03 — "create a linked item": the owner sets a leads button to create a job on the jobs board
 * (linked through the job's "lead" column, the address copied, status "draft", a popup with the job's columns, and
 * "open the draft again"). A click opens the popup over the leads board; saving creates the job and says so with
 * "open"; the next click opens the same draft for editing — no second job.
 */
const LABELS = [
  { id: 0, label: 'טיוטה', color: 'yellow', index: 0 },
  { id: 1, label: 'תואם', color: 'forest', index: 1, is_done: true },
];
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('a button creates a linked job from a popup, and opens the same draft on the next click', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const leads = await api<{ id: string }>('post', '/boards', { name: `לידים ${tag}`, workspace_id: ws.id });
  const jobs = await api<{ id: string }>('post', '/boards', { name: `עבודות ${tag}`, workspace_id: ws.id });
  const leadAddress = await api<{ id: string }>('post', `/boards/${leads.id}/columns`, {
    title: 'כתובת',
    type: 'text',
  });
  // A client on a third board, linked to the lead and copied to the job (a relation copied as is).
  const clients = await api<{ id: string }>('post', '/boards', { name: `לקוחות ${tag}`, workspace_id: ws.id });
  const clientName = `לקוחה ${tag}`;
  const client = await api<{ id: string }>('post', `/boards/${clients.id}/items`, { name: clientName });
  const leadClient = await api<{ id: string }>('post', `/boards/${leads.id}/columns`, {
    title: 'לקוח',
    type: 'board_relation',
    settings: { board_ids: [clients.id] },
  });
  const status = await api<{ id: string }>('post', `/boards/${jobs.id}/columns`, {
    title: 'סטטוס עבודה',
    type: 'status',
    settings: { labels: LABELS },
  });
  const address = await api<{ id: string }>('post', `/boards/${jobs.id}/columns`, { title: 'כתובת', type: 'text' });
  const access = await api<{ id: string }>('post', `/boards/${jobs.id}/columns`, { title: 'פרטי גישה', type: 'text' });
  const jobClient = await api<{ id: string }>('post', `/boards/${jobs.id}/columns`, {
    title: 'לקוח',
    type: 'board_relation',
    settings: { board_ids: [clients.id] },
  });
  const lead = await api<{ id: string }>('post', `/boards/${jobs.id}/columns`, {
    title: 'ליד',
    type: 'board_relation',
    settings: { board_ids: [leads.id] },
  });
  const button = await api<{ id: string }>('post', `/boards/${leads.id}/columns`, {
    title: 'תאם עבודה',
    type: 'button',
    settings: {
      action: {
        kind: 'create_linked',
        board_id: jobs.id,
        link: { on: 'target', column_id: lead.id },
        copy: [
          { from: leadAddress.id, to: address.id },
          { from: leadClient.id, to: jobClient.id },
        ],
        fixed: [{ column_id: status.id, text: 'טיוטה' }],
        popup: {
          fields: [{ column_id: access.id, required: true }, { column_id: address.id }, { column_id: jobClient.id }],
        },
        reuse: { column_id: status.id, labels: [0], empty: false },
      },
    },
  });
  const name = `מיכל ${tag}`;
  await api('post', `/boards/${leads.id}/items`, {
    name,
    cells: { [leadAddress.id]: 'הרצל 12, רחובות', [leadClient.id]: { item_ids: [client.id] } },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${leads.id}`);

  // The settings show the action as set: the jobs board, the link through "ליד" on the jobs board, the copy row.
  const header = page.locator(`[data-header="${button.id}"]`);
  await header.hover();
  await header.getByRole('button', { name: 'פעולות לעמודה תאם עבודה' }).click();
  await page.getByTestId('column-settings').click();
  const settings = page.getByTestId('button-linked');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('button-linked-board')).toHaveText(new RegExp(`עבודות ${tag}`));
  await expect(settings.getByTestId('button-linked-link')).toHaveText(/ליד \(בבורד של הפריט החדש\)/);
  await expect(settings.getByTestId('button-linked-copy-to').first()).toHaveText(/כתובת/);
  await page.screenshot({ path: test.info().outputPath('linked-settings.png') });
  await page.getByTestId('column-settings-save').click();

  // The click: a popup over the leads board with the job's columns; the address is already there from the lead.
  await row(page, name).locator(`[data-column="${button.id}"]`).getByTestId('button-cell').click();
  const popup = page.getByTestId('popup-dialog');
  await expect(popup).toBeVisible();
  await expect(page.getByRole('heading', { name: `תאם עבודה · ${name}` })).toBeVisible();
  await expect(popup.locator(`[data-column="${address.id}"]`)).toContainText('הרצל 12, רחובות');
  // Nothing is created until "save" — the popup says so.
  await expect(page.getByRole('dialog', { name: `תאם עבודה · ${name}` })).toContainText('רק כשלוחצים על "שמירה"');
  await expect(popup.locator(`[data-column="${jobClient.id}"]`).getByTestId('relation-chip')).toHaveText(clientName);

  // A linked item in the popup (the client copied from the lead) opens its card OVER the popup; Esc closes the card
  // only, and the popup is still there with what was in it.
  await popup.locator(`[data-column="${jobClient.id}"]`).getByTestId('relation-chip').click();
  const card = page.getByTestId('item-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText(clientName);
  await expect(popup).toBeVisible();
  const z = (sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => {
        let n: Element | null = el;
        while (n && getComputedStyle(n).position !== 'fixed') n = n.parentElement;
        return Number(getComputedStyle(n ?? el).zIndex);
      });
  expect(await z('[data-testid="item-card"]')).toBeGreaterThan(await z('[data-testid="popup-dialog"]'));
  await page.screenshot({ path: test.info().outputPath('linked-card-over-popup.png') });
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(popup).toBeVisible();
  await expect(popup.locator(`[data-column="${address.id}"]`)).toContainText('הרצל 12, רחובות');

  await page.getByTestId('popup-save').click();
  await expect(page.getByTestId('popup-error')).toContainText('פרטי גישה');
  await popup.locator(`[data-column="${access.id}"]`).click();
  await page.keyboard.type('קומה 3, קוד 1234');
  await page.keyboard.press('Enter');
  await page.screenshot({ path: test.info().outputPath('linked-popup.png') });
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();

  // Saved: still on the leads board, a message with "open"; the job is on the jobs board, linked and filled in.
  await expect(page).toHaveURL(new RegExp(`/b/${leads.id}$`));
  const toast = page.getByTestId('toast').filter({ hasText: 'נוצר' });
  await expect(toast).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('linked-toast.png') });
  const made = (
    await api<{ data: { id: string; cells: Record<string, { value: unknown } | undefined> }[] }>(
      'get',
      `/boards/${jobs.id}/items`,
    )
  ).data;
  expect(made).toHaveLength(1);
  expect(made[0]!.cells[address.id]?.value).toBe('הרצל 12, רחובות');
  expect(made[0]!.cells[access.id]?.value).toBe('קומה 3, קוד 1234');
  expect(made[0]!.cells[status.id]?.value).toEqual({ index: 0 });
  expect(made[0]!.cells[jobClient.id]?.value).toMatchObject({ item_ids: [client.id] });
  await toast.getByTestId('toast-action').click();
  await expect(page).toHaveURL(new RegExp(`/i/${made[0]!.id}`));
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/b/${leads.id}$`));

  // The next click opens the same draft (its values in the popup) — saving changes it, no second job.
  await row(page, name).locator(`[data-column="${button.id}"]`).getByTestId('button-cell').click();
  await expect(popup).toBeVisible();
  await expect(page.getByRole('heading', { name: `תאם עבודה · ${name} · עריכה` })).toBeVisible();
  await expect(popup.locator(`[data-column="${access.id}"]`)).toContainText('קומה 3, קוד 1234');
  await popup.locator(`[data-column="${access.id}"]`).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('קומה 4');
  await page.keyboard.press('Enter');
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'עודכן' })).toBeVisible();
  const after = (
    await api<{ data: { id: string; cells: Record<string, { value: unknown } | undefined> }[] }>(
      'get',
      `/boards/${jobs.id}/items`,
    )
  ).data;
  expect(after).toHaveLength(1);
  expect(after[0]!.cells[access.id]?.value).toBe('קומה 4');
});
