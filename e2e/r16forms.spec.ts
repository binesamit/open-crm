// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * r16forms — hidden values from a source. In the form editor: a text question takes its value from a link
 * parameter (?src=…), a status question from a label picked with the column's own control, and a connect-boards
 * question links every new item to an item picked from the linked board. The public link is opened with the
 * parameter in a fresh context, and the new item carries all three values.
 */

type Headers = Record<string, string>;
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;

const makeBoards = async (page: Page, suffix: string) => {
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const post = (path: string, data: unknown) => page.request.post(`/api/v1${path}`, { headers, data });
  const clients = await json<{ id: string }>(await post('/boards', { name: `לקוחות ${suffix}`, workspace_id: ws }));
  const client = await json<{ id: string }>(await post(`/boards/${clients.id}/items`, { name: `לקוח ${suffix}` }));
  const board = await json<{ id: string }>(await post('/boards', { name: `פניות ${suffix}`, workspace_id: ws }));
  await post(`/boards/${board.id}/columns`, { id: 'ref', title: 'מקור', type: 'text' });
  await post(`/boards/${board.id}/columns`, {
    id: 'stage',
    title: 'שלב',
    type: 'status',
    settings: {
      labels: [
        { id: 0, label: 'חדש', color: 'yellow', index: 0 },
        { id: 1, label: 'דחוף', color: 'crimson', index: 1 },
      ],
    },
  });
  await post(`/boards/${board.id}/columns`, {
    id: 'client',
    title: 'לקוח',
    type: 'board_relation',
    settings: { board_ids: [clients.id] },
  });
  return { boardId: board.id, clientId: client.id, clientName: `לקוח ${suffix}`, headers };
};

const formOf = async (page: Page, boardId: string, headers: Headers) => {
  const views = await json<{ data: { id: string; type: string }[] }>(
    await page.request.get(`/api/v1/boards/${boardId}/views`, { headers }),
  );
  const view = views.data.find((v) => v.type === 'form')!;
  return json<{
    questions: {
      column_key: string;
      hidden: boolean;
      hidden_source?: string;
      default_value?: unknown;
      hidden_param?: { name: string } | null;
      hidden_item?: { item_id: string } | null;
    }[];
  }>(await page.request.get(`/api/v1/views/${view.id}/form`, { headers }));
};

test('hidden values: from the link, picked from the column, and an item of the linked board', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);
  const b = await makeBoards(page, suffix);
  await page.goto(`/a/demo/b/${b.boardId}`);

  await page.getByTestId('view-add').click();
  await page.getByTestId('view-add-form').click();
  await page.getByRole('dialog').getByRole('textbox').fill('טופס מקורות');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('form-view')).toBeVisible();

  // 1. "Source" (text): hidden, from the link parameter "src".
  await page.getByTestId('form-add-question').click();
  await page.getByTestId('form-add-column-ref').click();
  const ref = page.locator('[data-testid="form-question"][data-column="ref"]');
  await ref.getByTestId('form-question-hidden').check();
  await ref.getByTestId('form-hidden-source-url').click();
  await ref.getByTestId('form-hidden-param-name').fill('src');
  await expect(ref.getByTestId('form-hidden-param-example')).toContainText('?src=');

  // 2. "Stage" (status): hidden, a label picked with the column's own control.
  await page.getByTestId('form-add-question').click();
  await page.getByTestId('form-add-column-stage').click();
  const stage = page.locator('[data-testid="form-question"][data-column="stage"]');
  await stage.getByTestId('form-question-hidden').check();
  await stage.getByTestId('form-hidden-source-choice').click();
  await stage.getByTestId('form-hidden-choice').getByRole('radio', { name: 'דחוף' }).click();

  // 3. "Client" (connect boards): hidden by itself; an item of the linked board, found by search.
  await page.getByTestId('form-add-question').click();
  await page.getByTestId('form-add-column-client').click();
  const client = page.locator('[data-testid="form-question"][data-column="client"]');
  await expect(client.getByTestId('form-hidden-source-item')).toHaveAttribute('aria-checked', 'true');
  await client.getByTestId('form-hidden-item-search').fill(b.clientName);
  await client.getByTestId('form-hidden-item-option').filter({ hasText: b.clientName }).click();
  await expect(client.getByTestId('form-hidden-item-picked')).toHaveText(b.clientName);

  // The editor saves by itself.
  await expect
    .poll(
      async () => {
        const form = await formOf(page, b.boardId, b.headers);
        const q = (key: string) => form.questions.find((x) => x.column_key === key);
        return [
          q('ref')?.hidden_param?.name,
          q('stage')?.hidden_source,
          q('stage')?.default_value,
          q('client')?.hidden_item?.item_id,
        ].join('|');
      },
      { timeout: 10_000 },
    )
    .toBe(`src|choice|1|${b.clientId}`);

  const link = await page.getByTestId('form-link').inputValue();
  const visitor = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void visitor.close().catch(() => undefined));
  const pub = await visitor.newPage();
  forbidNativeDialogs(pub);
  await pub.goto(`${link}?src=newsletter`);
  await expect(pub.getByTestId('public-form')).toBeVisible();
  // Only the name is asked; the hidden questions are not on the page.
  await expect(pub.locator('[data-testid^="form-question-"]')).toHaveCount(1);
  await pub.locator('[data-testid^="form-question-"]').first().getByRole('textbox').fill('פנייה מקישור');
  await pub.getByTestId('public-form-submit').click();
  await expect(pub.getByTestId('public-form-done')).toBeVisible();

  const items = await json<{ data: { name: string; cells: Record<string, { value: unknown }> }[] }>(
    await page.request.get(`/api/v1/boards/${b.boardId}/items`, { headers: b.headers }),
  );
  const item = items.data.find((i) => i.name === 'פנייה מקישור')!;
  expect(item.cells.ref!.value).toBe('newsletter');
  expect(item.cells.stage!.value).toEqual({ index: 1 });
  expect((item.cells.client!.value as { item_ids: string[] }).item_ids).toEqual([b.clientId]);

  // A value of the link that does not fit is refused, and the page says the link is not valid.
  // (One question is open at a time: "Client" was added last, so "Stage" is opened again.)
  const stageToggle = stage.getByTestId('form-question-toggle');
  if ((await stageToggle.getAttribute('aria-expanded')) !== 'true') await stageToggle.click();
  await stage.getByTestId('form-hidden-source-url').click();
  await stage.getByTestId('form-hidden-param-name').fill('stage');
  await expect
    .poll(
      async () =>
        (await formOf(page, b.boardId, b.headers)).questions.find((x) => x.column_key === 'stage')?.hidden_param?.name,
      { timeout: 10_000 },
    )
    .toBe('stage');
  const bad = await visitor.newPage();
  await bad.goto(`${link}?stage=nope`);
  await bad.locator('[data-testid^="form-question-"]').first().getByRole('textbox').fill('קישור שגוי');
  await bad.getByTestId('public-form-submit').click();
  await expect(bad.getByTestId('public-form-error')).toHaveAttribute('data-reason', 'link');
  await expect(bad.getByTestId('public-form-done')).toHaveCount(0);
});
