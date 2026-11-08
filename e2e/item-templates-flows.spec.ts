// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Item templates, phase 2: an automation "when an item is created → create an item from template X
 * on another board" built in the sentence builder (the template, its questions answered from the item, the links
 * both ways) and run by the engine; a form whose submissions create their item from a template (picked in the form's
 * settings, its question answered by the form's name question); "item from a template" on an empty board.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = {
  id: 'root',
  name: '{name}',
  cells: {},
  updates: [],
  children: [
    { id: 'a', name: 'התנעה עם {name}', cells: {}, updates: [], children: [] },
    { id: 'b', name: 'מסירה', cells: {}, updates: [], children: [] },
  ],
};
const variables = [
  { key: 'name', label: 'שם', type: 'text', required: true, default: null },
  { key: 'start', label: 'התחלה', type: 'date', required: false, default: 'today' },
];

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const get = async (path: string) => (await (await page.request.get(api(path), { headers })).json()) as Json;
  const post = async (path: string, data: unknown) => {
    const res = await page.request.post(api(path), { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return (await res.json()) as Json;
  };
  const ws = (await get('/workspaces')).data[0].id as string;
  return { headers, get, post, ws };
};

test('automation: create an item from a template on another board, linked both ways', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { get, post, ws } = await setup(page);
  const run = Date.now().toString(36);
  const clients = await post('/boards', { name: `לקוחות ${run}`, workspace_id: ws });
  const projects = await post('/boards', { name: `פרויקטים ${run}`, workspace_id: ws });
  await post(`/boards/${clients.id}/columns`, {
    id: 'projects',
    title: 'פרויקטים',
    type: 'board_relation',
    settings: { board_ids: [projects.id] },
  });
  await post(`/boards/${projects.id}/columns`, {
    id: 'client',
    title: 'לקוח',
    type: 'board_relation',
    settings: { board_ids: [clients.id] },
  });
  await post(`/boards/${projects.id}/item-templates`, { name: `פרויקט ${run}`, variables, root });

  await page.goto(`/a/demo/b/${clients.id}`);
  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.getByTestId('auto-custom').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();
  await builder.getByTestId('auto-trigger-type').click();
  await page.getByTestId('auto-trigger-item_created').click();
  await builder.getByTestId('auto-add-action').click();
  await page.getByTestId('auto-action-create_item_from_template').click();

  // The blanks: the board, then one of its templates (its name question is answered by the item's name at once).
  await builder.locator('[data-slot="actions.0.board"]').click();
  await page
    .getByTestId('slot-option')
    .filter({ hasText: `פרויקטים ${run}` })
    .click();
  await builder.locator('[data-slot="actions.0.template"]').click();
  await page
    .getByTestId('slot-option')
    .filter({ hasText: `פרויקט ${run}` })
    .click();
  await expect(builder.locator('[data-slot="actions.0.template"]')).toHaveText(`פרויקט ${run}`);

  // The settings: the proposal, and the links both ways.
  await builder.getByTestId('auto-template-setup').click();
  const fields = page.getByTestId('auto-template-fields');
  await expect(fields).toBeVisible();
  await expect(fields.getByTestId('auto-template-var-name')).toHaveText(/שם הפריט/);
  await fields.getByTestId('auto-template-connect').click();
  await page.getByRole('menu').getByText('פרויקטים', { exact: true }).click();
  await fields.getByTestId('auto-template-connect-back').click();
  await page.getByRole('menu').getByText('לקוח', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(fields).toHaveCount(0);
  await expect(builder).toBeVisible();
  await page.getByTestId('auto-title').fill(`תבנית ${run}`);
  await page.getByTestId('auto-save').click();
  await expect(page.locator('[data-testid="automation-row"]', { hasText: `תבנית ${run}` })).toBeVisible();
  await page.getByRole('button', { name: 'סגירת החלון' }).last().click();

  // An item on the board → the engine makes the project from the template, linked both ways.
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('חברת יוטא');
  await add.press('Enter');
  await expect
    .poll(async () => ((await post(`/boards/${projects.id}/items/query`, {})).data as Json[]).map((i) => i.name), {
      timeout: 20_000,
    })
    .toEqual(['חברת יוטא']);
  const project = (await post(`/boards/${projects.id}/items/query`, {})).data[0] as Json;
  expect(((await get(`/items/${project.id}/subitems`)).data as Json[]).map((s) => s.name)).toEqual([
    'התנעה עם חברת יוטא',
    'מסירה',
  ]);
  const lead = ((await post(`/boards/${clients.id}/items/query`, {})).data as Json[]).find(
    (i) => i.name === 'חברת יוטא',
  )!;
  // The links are made right after the tree (the run's last writes).
  await expect.poll(async () => (await get(`/items/${project.id}`)).cells.client?.value?.item_ids).toEqual([lead.id]);
  await expect.poll(async () => (await get(`/items/${lead.id}`)).cells.projects?.value?.item_ids).toEqual([project.id]);
});

test('form: each submission creates its item from a template; the empty board offers the templates', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { get, post, ws } = await setup(page);
  const run = Date.now().toString(36);
  const board = await post('/boards', { name: `הרשמות ${run}`, workspace_id: ws });
  const tpl = await post(`/boards/${board.id}/item-templates`, { name: `קליטה ${run}`, variables, root });

  // The empty board: "item from a template" opens the apply dialog with the board's templates.
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.getByTestId('board-empty')).toBeVisible();
  await page.getByTestId('board-empty-from-template').click();
  await expect(page.getByTestId('item-template-apply-dialog')).toBeVisible();
  await expect(page.locator('[data-testid="item-template-choice"]', { hasText: `קליטה ${run}` })).toBeVisible();
  await page.keyboard.press('Escape');

  // The form's settings: the template, and its name question answered by the form's name question.
  const view = await post(`/boards/${board.id}/views`, { type: 'form', name: 'הרשמה' });
  await page.goto(`/a/demo/b/${board.id}?view=${view.id}`);
  await expect(page.getByTestId('form-view')).toBeVisible();
  await page.getByTestId('form-item-template-picker').click();
  await page.getByRole('menu').getByText(`קליטה ${run}`, { exact: true }).click();
  await expect(page.getByTestId('form-item-template-var-name')).not.toHaveText(/ברירת המחדל/);
  await expect
    .poll(async () => (await get(`/views/${view.id}/form`)).settings.item_template?.template_id, { timeout: 10_000 })
    .toBe(tpl.id);
  const form = await get(`/views/${view.id}/form`);
  const nameQuestion = (form.questions as Json[]).find((q) => q.column_key === 'name')!;
  expect(form.settings.item_template.variables).toEqual({ name: nameQuestion.id });

  // A visitor submits: the item comes with the template's subitems, named from the answer.
  const link = await page.getByTestId('form-link').inputValue();
  const visitor = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void visitor.close().catch(() => undefined));
  const pub = await visitor.newPage();
  forbidNativeDialogs(pub);
  await pub.goto(link);
  await expect(pub.getByTestId('public-form')).toBeVisible();
  await pub.locator('[data-testid^="form-question-"]').first().getByRole('textbox').fill('חברת קאפא');
  await pub.getByTestId('public-form-submit').click();
  await expect(pub.getByTestId('public-form-done')).toBeVisible();
  await expect
    .poll(async () => ((await post(`/boards/${board.id}/items/query`, {})).data as Json[]).map((i) => i.name))
    .toEqual(['חברת קאפא']);
  const item = (await post(`/boards/${board.id}/items/query`, {})).data[0] as Json;
  expect(((await get(`/items/${item.id}/subitems`)).data as Json[]).map((s) => s.name)).toEqual([
    'התנעה עם חברת קאפא',
    'מסירה',
  ]);
});
