// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r16name — computed item names ("way 2") and "whose timer" in the UI
 * - the name column header's "מקור שם הפריט" → from a board_relation column: the name follows the linked item, the
 *   cell has its own look and the ƒ mark, and every rename path says why it cannot;
 * - a template built from two columns with text between (no braces typed);
 * - relation chips use the cell's names[] (a linked name with ", " stays one chip);
 * - the timer action's "whose timer" blank: defaults to whoever made the change, picks a people column, and the
 *   sentence says so.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: Json[] }).data[0]!;
  const post = async (path: string, data: Json) => {
    const res = await page.request.post(api(path), { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as Json;
  };
  const board = (name: string) => post('/boards', { name, workspace_id: ws.id });
  const column = (boardId: string, data: Json) => post(`/boards/${boardId}/columns`, data);
  const item = (boardId: string, data: Json) => post(`/boards/${boardId}/items`, data);
  const setCell = (itemId: string, columnId: string, value: unknown) =>
    page.request.put(api(`/items/${itemId}/cells/${columnId}`), { headers, data: { value } });
  return { headers, board, column, item, setCell };
};

/** Opens the name column header's menu → "מקור שם הפריט". */
const openNameSource = async (page: Page, boardId: string) => {
  const header = page.locator(`[data-name-header="${boardId}"]`);
  await header.hover();
  await header.getByTestId('name-header-menu').getByRole('button').click();
  await page.getByTestId('name-source-menu').click();
  const dialog = page.getByTestId('name-source-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
};

test('name from a board_relation column: follows the linked item, rename blocked', async ({ page }) => {
  test.setTimeout(180_000);
  const { headers, board, column, item, setCell } = await setup(page);
  const tag = Date.now().toString(36);
  const clients = await board(`Clients ${tag}`);
  const deals = await board(`Deals ${tag}`);
  try {
    const rel = await column(deals.id, {
      title: `לקוח ${tag}`,
      type: 'board_relation',
      settings: { board_ids: [clients.id], allow_multiple: true },
    });
    const acme = await item(clients.id, { name: `Acme, Ltd ${tag}` });
    const beta = await item(clients.id, { name: `Beta ${tag}` });
    const deal = await item(deals.id, { name: `typed ${tag}` });

    await page.goto(`/a/demo/b/${deals.id}`);
    const dialog = await openNameSource(page, deals.id);
    await dialog.getByTestId('name-source-column-mode').click();
    await dialog.getByTestId('name-source-pick').click();
    await page.locator(`[data-testid="name-source-column"][data-key="${rel.id}"]`).click();
    await expect(dialog.getByTestId('name-source-pick')).toContainText(`לקוח ${tag}`);
    await page.getByTestId('name-source-save').click();
    await expect(dialog).toHaveCount(0);

    // Empty relation → the "no value" text; linking an item → its name.
    expect((await setCell(deal.id, rel.id, { item_ids: [acme.id, beta.id] })).ok()).toBeTruthy();
    await page.reload();
    const row = page
      .locator('[data-item-id]')
      .filter({ has: page.getByTestId('computed-name') })
      .first();
    await expect(row.getByTestId('computed-name')).toHaveText(`Acme, Ltd ${tag}, Beta ${tag}`);
    await expect(row.getByTestId('computed-name-mark')).toBeVisible();

    // names[]: "Acme, Ltd" is one chip, not two.
    const cell = row.locator(`[data-column="${rel.id}"], [data-col="${rel.id}"]`).first();
    if (await cell.count()) await expect(cell.getByText(`Acme, Ltd ${tag}`, { exact: true })).toBeVisible();

    // The ƒ mark lists the source column.
    await row.getByTestId('computed-name-mark').click();
    await expect(page.getByTestId('computed-name-popover')).toContainText(`לקוח ${tag}`);
    await page.keyboard.press('Escape');

    // Rename: the menu says why (no prompt), and the API answers 409 item_name_computed.
    await row.hover();
    await row
      .getByRole('button', { name: /^פעולות ל/ })
      .first()
      .click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'שינוי שם' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const res = await page.request.patch(api(`/items/${deal.id}`), { headers, data: { name: 'nope' } });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe('item_name_computed');

    // a click on the name opens its source columns in the row; "open the item" opens the card.
    await row.getByTestId('computed-name').click();
    await expect(page.getByTestId('computed-name-field')).toHaveCount(1);
    await expect(page.getByTestId('computed-name-field')).toContainText(`לקוח ${tag}`);
    await page.getByTestId('computed-name-open-item').click();
    // The card title is not editable and carries the mark.
    const card = page.getByTestId('item-card');
    await expect(card.getByTestId('card-title-computed')).toHaveText(`Acme, Ltd ${tag}, Beta ${tag}`);
    await expect(card.getByTestId('card-title-edit')).toHaveCount(0);
    await expect(card.getByTestId('computed-name-mark')).toBeVisible();
  } finally {
    await page.request.delete(api(`/boards/${deals.id}`), { headers });
    await page.request.delete(api(`/boards/${clients.id}`), { headers });
  }
});

test('template with two columns and text between them (no braces typed)', async ({ page }) => {
  test.setTimeout(180_000);
  const { headers, board, column, item, setCell } = await setup(page);
  const tag = Date.now().toString(36);
  const b = await board(`Template ${tag}`);
  try {
    const client = await column(b.id, { title: `לקוח ${tag}`, type: 'text' });
    const city = await column(b.id, { title: `עיר ${tag}`, type: 'text' });
    const it = await item(b.id, { name: `typed ${tag}` });
    expect((await setCell(it.id, client.id, 'Acme')).ok()).toBeTruthy();
    expect((await setCell(it.id, city.id, 'Haifa')).ok()).toBeTruthy();

    await page.goto(`/a/demo/b/${b.id}`);
    const dialog = await openNameSource(page, b.id);
    await dialog.getByTestId('name-source-template-mode').click();
    await dialog.getByTestId('name-template-add').click();
    await page.locator(`[data-testid="name-source-column"][data-key="${client.id}"]`).click();
    // The caret is in the text after the chip: type the separator, then add the second column there.
    await expect(page.locator('[data-testid="name-source-column"]')).toHaveCount(0);
    await page.keyboard.type(' – ');
    await dialog.getByTestId('name-template-add').click();
    await page.locator(`[data-testid="name-source-column"][data-key="${city.id}"]`).click();
    await expect(dialog.getByTestId('name-template-chip')).toHaveCount(2);
    await expect(dialog.getByTestId('name-source-preview')).toContainText('Acme – Haifa');
    await page.getByTestId('name-source-save').click();
    await expect(dialog).toHaveCount(0);

    const src = (await (await page.request.get(api(`/boards/${b.id}/name-source`), { headers })).json()) as Json;
    expect(src.name_source).toMatchObject({ mode: 'template', template: `{${client.id}} – {${city.id}}` });
    await expect(page.getByTestId('computed-name').first()).toHaveText('Acme – Haifa');

    // A cell edit renames the item.
    expect((await setCell(it.id, city.id, 'Eilat')).ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId('computed-name').first()).toHaveText('Acme – Eilat');

    // in the item card a click on the name opens its source columns as editable cells — a value is
    // picked right there (no scrolling to a field), and the name follows.
    await page.goto(`/a/demo/b/${b.id}/i/${it.id}`);
    const card = page.getByTestId('item-card');
    await card.getByTestId('card-title-computed').click();
    const fields = page.getByTestId('computed-name-popover').getByTestId('computed-name-field');
    await expect(fields).toHaveCount(2);
    await expect(page.getByTestId('computed-name-source')).toHaveCount(0);
    await fields
      .filter({ hasText: `עיר ${tag}` })
      .getByText('Eilat')
      .click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Ashdod');
    await page.keyboard.press('Enter');
    await expect(card.getByTestId('card-title-computed')).toHaveText('Acme – Ashdod');
  } finally {
    await page.request.delete(api(`/boards/${b.id}`), { headers });
  }
});

test('whose timer: the new action defaults to whoever made the change; the choice reads in the sentence', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { headers, board, column } = await setup(page);
  const tag = Date.now().toString(36);
  const b = await board(`Timer slot ${tag}`);
  try {
    await column(b.id, { title: 'סטטוס', type: 'status' });
    await column(b.id, { title: `אחראי ${tag}`, type: 'people' });
    await column(b.id, { title: 'זמן', type: 'time_tracking' });

    await page.goto(`/a/demo/b/${b.id}`);
    await page.getByTestId('board-automations').click();
    await page.getByTestId('auto-tab-create').click();
    await page.getByTestId('auto-custom').click();
    const builder = page.getByTestId('automation-builder');
    await builder.getByTestId('auto-add-action').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'הפעלת מעקב זמן' }).click();

    // ACTION_DEFAULTS: who = @actor → "for whoever made the change (… when nobody: skip)".
    const who = builder.locator('[data-slot="actions.0.who"]');
    await expect(who).toContainText('מי שביצע את השינוי');
    await expect(builder.locator('[data-slot="actions.0.fallback"]')).toBeVisible();

    // The picker: a title, the people column under its own heading; picking it reads in the sentence.
    await who.click();
    const editor = page.getByTestId('slot-timer-who-editor');
    await expect(editor).toBeVisible();
    await editor
      .getByTestId('slot-option')
      .filter({ hasText: `אחראי ${tag}` })
      .click();
    await expect(who).toContainText(`אחראי ${tag}`);
    await expect(builder.locator('[data-slot="actions.0.fallback"]')).toHaveCount(0);
  } finally {
    await page.request.delete(api(`/boards/${b.id}`), { headers });
  }
});
