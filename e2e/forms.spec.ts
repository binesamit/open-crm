// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * M11 public forms: a "Form" view is added from the view menu, three questions are configured (the name, a text
 * column and a status column), the public link opens in a fresh browser context (no session), the form is
 * submitted there, and the new item appears on the board.
 */

/** A board with a text and a status column (through the API — the board UI is not under test here). */
const makeBoard = async (page: Page, name: string) => {
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name, workspace_id: ws } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'company', title: 'חברה', type: 'text' },
  });
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: {
      id: 'stage',
      title: 'שלב',
      type: 'status',
      settings: {
        labels: [
          { id: 0, label: 'חדש', color: 'yellow', index: 0 },
          { id: 1, label: 'דחוף', color: 'crimson', index: 1 },
        ],
      },
    },
  });
  return { id: board.id, headers };
};

test('a form view: configure three questions, submit the public link, the item lands on the board', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardName = `טופס ${Date.now().toString(36)}`;
  const board = await makeBoard(page, boardName);
  await page.goto(`/a/demo/b/${board.id}`);

  // Add a Form view from the "+" menu like any other view.
  await page.getByTestId('view-add').click();
  await page.getByTestId('view-add-form').click();
  await page.getByRole('dialog').getByRole('textbox').fill('טופס פנייה');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('form-view')).toBeVisible();
  // A new form starts with the item name as its question.
  await expect(page.getByTestId('form-question')).toHaveCount(1);

  // Question 2: the text column, required, with its own label.
  await page.getByTestId('form-add-question').click();
  await page.getByTestId('form-add-column-company').click();
  const company = page.locator('[data-testid="form-question"][data-column="company"]');
  await company.getByTestId('form-question-label').fill('שם החברה');
  await company.getByTestId('form-question-required').check();
  // Question 3: the status column.
  await page.getByTestId('form-add-question').click();
  await page.getByTestId('form-add-column-stage').click();
  await expect(page.getByTestId('form-question')).toHaveCount(3);

  // The editor saves by itself; wait for the save that holds all three questions.
  await expect
    .poll(
      async () => {
        const views = (await (
          await page.request.get(`/api/v1/boards/${board.id}/views`, { headers: board.headers })
        ).json()) as { data: { id: string; type: string }[] };
        const view = views.data.find((v) => v.type === 'form')!;
        const form = (await (
          await page.request.get(`/api/v1/views/${view.id}/form`, { headers: board.headers })
        ).json()) as { questions: { column_key: string; required: boolean }[] };
        return form.questions.map((q) => `${q.column_key}:${q.required}`).join(',');
      },
      { timeout: 10_000 },
    )
    .toBe('name:true,company:true,stage:false');

  const link = await page.getByTestId('form-link').inputValue();
  expect(link).toMatch(/\/f\/[a-z0-9]{24}$/);

  // The public page, in a fresh context: no session, no shell.
  const visitor = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void visitor.close().catch(() => undefined));
  const pub = await visitor.newPage();
  forbidNativeDialogs(pub);
  await pub.goto(link);
  await expect(pub.getByTestId('public-form')).toBeVisible();
  await expect(pub.getByTestId('public-form-page')).toHaveAttribute('dir', 'rtl');
  await expect(pub.getByText('שם החברה')).toBeVisible();
  // Required answers are checked before sending.
  await pub.getByTestId('public-form-submit').click();
  await expect(pub.locator('[data-testid^="form-error-"]')).toHaveCount(2);

  const questions = pub.locator('[data-testid^="form-question-"]');
  await questions.nth(0).getByRole('textbox').fill('דנה מהטופס');
  await questions.nth(1).getByRole('textbox').fill('דנה בע"מ');
  await questions.nth(2).getByRole('radio', { name: 'דחוף' }).click();
  await pub.getByTestId('public-form-submit').click();
  await expect(pub.getByTestId('public-form-done')).toBeVisible();

  // Back on the board: the item is there, with its answers.
  await page.getByTestId('view-tab').first().click();
  const row = page.getByText('דנה מהטופס');
  await expect(row).toBeVisible({ timeout: 10_000 });
  const items = (await (
    await page.request.get(`/api/v1/boards/${board.id}/items`, { headers: board.headers })
  ).json()) as { data: { name: string; cells: Record<string, { value: unknown }> }[] };
  const item = items.data.find((i) => i.name === 'דנה מהטופס')!;
  expect(item.cells.company!.value).toBe('דנה בע"מ');
  expect(item.cells.stage!.value).toEqual({ index: 1 });
});
