// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, rowMenu, signIn } from './helpers';

/**
 * Item templates: an item with subitems and sub-subitems saved as a template from its menu; "new
 * item ▾" makes one from it after asking its questions (one undo takes it all back); the card adds a template's
 * subitems under an item; the editor changes the tree (a new version).
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

test('save an item as a template, make items from it, undo, subitems from it, edit it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const get = async (path: string) => (await (await page.request.get(api(path), { headers })).json()) as Json;
  const post = async (path: string, data: unknown) =>
    (await (await page.request.post(api(path), { headers, data })).json()) as Json;
  const ws = (await get('/workspaces')).data[0].id as string;
  const board = await post('/boards', { name: `תבניות ${Date.now().toString(36)}`, workspace_id: ws });
  await post(`/boards/${board.id}/columns`, { id: 'due', title: 'יעד', type: 'date' });
  const source = await post(`/boards/${board.id}/items`, {
    name: 'לקוח אלפא',
    cells: { due: { date: '2026-11-08' } },
  });
  const kickoff = await post(`/items/${source.id}/subitems`, {
    name: 'פגישת התנעה',
    cells: { date: { date: '2026-11-10' } },
  });
  await post(`/items/${kickoff.id}/subitems`, { name: 'סיכום הפגישה' });
  await post(`/items/${source.id}/updates`, { body: 'ברוכים הבאים, לקוח אלפא' });

  await page.goto(`/a/demo/b/${board.id}`);
  // Save as a template from the item's menu.
  await rowMenu(page, row(page, 'לקוח אלפא'), 'שמירה כתבנית');
  const save = page.getByTestId('item-template-save-dialog');
  await expect(save).toBeVisible();
  await save.getByTestId('item-template-name').fill('קליטת לקוח');
  await page.getByTestId('item-template-save').click();
  await expect(save).toHaveCount(0);
  await expect.poll(async () => (await get(`/boards/${board.id}/item-templates`)).data.length).toBe(1);

  // "New item ▾" lists it; applying asks for the name (the start date defaults to today).
  await page.getByTestId('board-new-item-more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'קליטת לקוח' }).click();
  const apply = page.getByTestId('item-template-apply-dialog');
  await expect(apply).toBeVisible();
  await expect(page.getByTestId('item-template-apply')).toBeDisabled();
  await apply.getByTestId('item-template-var-name').fill('לקוח בטא');
  await expect(apply.getByTestId('item-template-preview-row').first()).toHaveText(/לקוח בטא/);
  await expect(apply.getByTestId('item-template-preview-row')).toHaveCount(3);
  await page.getByTestId('item-template-apply').click();
  await expect(row(page, 'לקוח בטא')).toBeVisible();
  const made = (await post(`/boards/${board.id}/items/query`, {})).data.find((i: Json) => i.name === 'לקוח בטא');
  expect(made.cells.due.value).toEqual({ date: today() });
  const subs = (await get(`/items/${made.id}/subitems`)).data as Json[];
  expect(subs.map((s) => s.name)).toEqual(['פגישת התנעה']);
  expect((await get(`/items/${subs[0].id}/subitems`)).data.map((s: Json) => s.name)).toEqual(['סיכום הפגישה']);
  const updates = (await get(`/items/${made.id}/updates`)).data as Json[];
  expect(JSON.stringify(updates)).toContain('ברוכים הבאים, לקוח בטא');

  // One undo takes the whole tree back.
  await page.getByRole('button', { name: 'ביטול' }).last().click();
  await expect(row(page, 'לקוח בטא')).toHaveCount(0);

  // The card: the template's subitems under an existing item.
  const target = await post(`/boards/${board.id}/items`, { name: 'לקוח קיים' });
  await page.goto(`/a/demo/b/${board.id}/i/${target.id}`);
  const card = page.getByTestId('item-card');
  await expect(card).toBeVisible();
  await card
    .getByRole('button', { name: /^פעולות לפריט/ })
    .first()
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'תתי-פריטים מתבנית…' }).click();
  await page.getByTestId('item-template-choice').first().click();
  await page.getByTestId('item-template-var-name').fill('לקוח קיים');
  await page.getByTestId('item-template-apply').click();
  await expect
    .poll(async () => ((await get(`/items/${target.id}/subitems`)).data as Json[]).map((s) => s.name))
    .toEqual(['פגישת התנעה']);

  // The editor: a new subitem under the item → a new version.
  await page.goto(`/a/demo/b/${board.id}`);
  const tpl = (await get(`/boards/${board.id}/item-templates`)).data[0];
  await page.getByTestId('board-new-item-more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'ניהול התבניות…' }).click();
  await page.getByTestId('item-template-edit').first().click();
  const editor = page.getByTestId('item-template-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('item-template-node')).toHaveCount(3);
  await editor.getByTestId('item-template-node').first().click();
  await editor.getByTestId('item-template-add-child').click();
  await editor.getByTestId('item-template-node-name').fill('מסירה');
  await editor.getByTestId('item-template-editor-save').click();
  await expect.poll(async () => (await get(`/item-templates/${tpl.id}`)).version).toBe(2);
  expect((await get(`/item-templates/${tpl.id}`)).root.children.map((c: Json) => c.name)).toEqual([
    'פגישת התנעה',
    'מסירה',
  ]);
});
