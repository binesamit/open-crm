// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, rowMenu, signIn } from './helpers';
import { WEB_URL } from './stack';
import { enrol, totp } from './two-factor';

/**
 * PRJ-015, 2026-10-27: a check box secret, shown or hidden; a board whose deletes take a verification code
 * a form's secret question; a click on an empty calendar day.
 */
const setup = async (page: Page, name: string) => {
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `${name} ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = async (n: string) =>
    (await (await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: n } })).json()) as {
      id: string;
    };
  return { headers, board, item };
};

test('a check box secret: hidden like any secret, or shown without a code and flipped with a click', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  const { headers, board, item } = await setup(page, 'סימון סודי');
  for (const [id, visible] of [
    ['hidden', false],
    ['shown', true],
  ] as const)
    await page.request.post(`/api/v1/boards/${board.id}/columns`, {
      headers,
      data: {
        id,
        title: id,
        type: 'secret',
        settings: { kind: 'checkbox', checkbox_visible: visible, change_requires_code: false },
      },
    });
  const it = await item('גישה');
  for (const key of ['hidden', 'shown'])
    await page.request.put(`/api/v1/items/${it.id}/cells/${key}/secret`, { headers, data: { value: '1' } });
  await page.goto(`/a/demo/b/${board.id}`);
  const cell = (key: string) =>
    page.locator(`[data-item-id="${it.id}"] [data-column="${key}"]`).first().getByTestId('secret-cell');
  // Hidden: "••••", never whether it is checked.
  await expect(cell('hidden').getByTestId('secret-masked')).toHaveText('••••••');
  await expect(cell('hidden').getByTestId('secret-checkbox')).toHaveCount(0);
  // Shown: the check box itself; a click un-checks it (this column asks no code for a change).
  const box = cell('shown').getByTestId('secret-checkbox');
  await expect(box).toHaveAttribute('data-checked', 'true');
  await box.click();
  await expect(box).not.toHaveAttribute('data-checked');

  // a column whose changes take a code asks for it even to check an EMPTY box (an empty box is "not
  // checked" — checking it is a change); the box stays unchecked meanwhile.
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'guarded', title: 'guarded', type: 'secret', settings: { kind: 'checkbox', checkbox_visible: true } },
  });
  await page.reload();
  const guarded = cell('guarded').getByTestId('secret-checkbox');
  await expect(guarded).not.toHaveAttribute('data-checked');
  await guarded.click();
  await expect(page.locator('[data-testid="secret-code-panel"], [data-testid="secret-no2fa-panel"]')).toBeVisible();
  await expect(guarded).not.toHaveAttribute('data-checked');
});

test('a board whose deletes take a code: the item menu asks for it, then deletes', async ({ page, browser }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  const { headers, board, item } = await setup(page, 'מחיקה עם קוד');
  const it = await item('למחיקה');
  const put = await page.request.put(`/api/v1/boards/${board.id}/permissions`, {
    headers,
    data: { delete_guard: { enabled: true, verify_minutes: 15 } },
  });
  expect(put.status()).toBe(200);
  const mate = await newTeammate(page, browser, `מוחק ${Date.now().toString(36)}`);
  forbidNativeDialogs(mate);
  const uri = await enrol(mate);
  // Enrolling counts as no code for secrets: the first delete asks.
  await mate.goto(`/a/demo/b/${board.id}`);
  const row = mate.locator(`[data-item-id="${it.id}"]`).first();
  await rowMenu(mate, row, 'מחיקה');
  const confirm = mate.getByRole('alertdialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: 'מחיקה' }).click();
  await expect(mate.getByTestId('secret-stepup-code')).toBeVisible();
  await mate.getByTestId('secret-stepup-input').fill(totp(uri));
  await mate.getByTestId('secret-stepup-submit').click();
  await expect(mate.locator(`[data-item-id="${it.id}"]`)).toHaveCount(0);
  // The permissions dialog shows the switch on (the owner's view).
  await page.goto(`/a/demo/b/${board.id}`);
  const perms = (await (await page.request.get(`/api/v1/boards/${board.id}/permissions`, { headers })).json()) as {
    delete_guard: { enabled: boolean };
  };
  expect(perms.delete_guard.enabled).toBe(true);
});

test("a form's secret question: typed hidden, saved encrypted on the new item", async ({ page, browser }) => {
  forbidNativeDialogs(page);
  const { headers, board } = await setup(page, 'טופס סודות');
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'pwd', title: 'סיסמה', type: 'secret' },
  });
  const view = (await (
    await page.request.post(`/api/v1/boards/${board.id}/views`, { headers, data: { type: 'form', name: 'גישות' } })
  ).json()) as { id: string };
  // The form's own row comes with its first read (its link and defaults).
  expect((await page.request.get(`/api/v1/views/${view.id}/form`, { headers })).status()).toBe(200);
  const saved = await page.request.patch(`/api/v1/views/${view.id}/form`, {
    headers,
    data: {
      questions: [
        { id: 'qname001', column_key: 'name', required: true },
        { id: 'qpwd0001', column_key: 'pwd', required: true },
      ],
    },
  });
  expect(saved.status()).toBe(200);
  const { token } = (await saved.json()) as { token: string };
  const visitor = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const pub = await visitor.newPage();
  forbidNativeDialogs(pub);
  await pub.goto(`/f/${token}`);
  await expect(pub.getByTestId('public-form')).toBeVisible();
  await pub.getByTestId('form-input-qname001').fill('לקוח חדש');
  const secret = pub.getByTestId('form-input-qpwd0001');
  await secret.fill('Typed-S3cret-77');
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(pub.getByTestId('form-secret-note-qpwd0001')).toBeVisible();
  await pub.getByTestId('form-secret-toggle-qpwd0001').click();
  await expect(secret).toHaveAttribute('type', 'text');
  await pub.getByTestId('public-form-submit').click();
  await expect(pub.getByTestId('public-form-done')).toBeVisible();
  await visitor.close();
  const rows = (await (await page.request.get(`/api/v1/boards/${board.id}/items`, { headers })).json()) as {
    data: { name: string; cells: Record<string, { value?: { set?: boolean } }> }[];
  };
  const created = rows.data.find((r) => r.name === 'לקוח חדש')!;
  expect(created.cells.pwd?.value?.set).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('Typed-S3cret-77');
});

test('a click on an empty calendar day: a new item on that day', async ({ page }) => {
  forbidNativeDialogs(page);
  const { headers, board } = await setup(page, 'לוח שנה');
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'due', title: 'תאריך יעד', type: 'date' },
  });
  const view = (await (
    await page.request.post(`/api/v1/boards/${board.id}/views`, { headers, data: { type: 'calendar', name: 'לוח' } })
  ).json()) as { id: string };
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/a/demo/b/${board.id}?view=${view.id}`);
  const day = page.locator('[data-testid="calendar-day"][data-day$="-15"]').first();
  const iso = (await day.getAttribute('data-day'))!;
  const box = (await day.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
  await expect(page.getByTestId('calendar-day-panel')).toBeVisible();
  await page.getByTestId('calendar-day-name').fill('פגישה ביום ריק');
  await page.getByTestId('calendar-day-create').click();
  await expect(page.getByTestId('calendar-day-panel')).toHaveCount(0);
  // The month's items sit in a layer over the days, each with the day it starts on.
  await expect(
    page.locator(`[data-testid="calendar-item"][data-day="${iso}"]`).filter({ hasText: 'פגישה ביום ריק' }),
  ).toBeVisible();
  const rows = (await (await page.request.get(`/api/v1/boards/${board.id}/items`, { headers })).json()) as {
    data: { name: string; cells: Record<string, { value?: { date?: string } }> }[];
  };
  expect(rows.data.find((r) => r.name === 'פגישה ביום ריק')!.cells.due?.value?.date).toBe(iso);
});
