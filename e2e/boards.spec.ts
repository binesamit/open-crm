// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { openNewBoard } from './helpers';
import { MAILPIT_URL as MAILPIT } from './stack';

/** Phase 1 slice A: kit boards in the sidebar, inline editing, a new board with a column. */
const OWNER = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';

const latestMail = async (to: string): Promise<string> => {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    const id = ((await res.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
    if (id) return ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string }).Text;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail to ${to}`);
};

test('edit the leads board and create a board', async ({ page }) => {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  await page.goto('/');
  await page.getByLabel('אימייל').fill(OWNER);
  await page.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
  await expect(page.getByText('נשלח אליה קישור כניסה')).toBeVisible();
  await page.goto(/https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(OWNER))![0]);
  const join = page.getByRole('button', { name: 'הצטרפות' });
  if (await join.isVisible().catch(() => false)) await join.click();
  await page.waitForURL(/\/a\/demo/);

  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לידים');
  const name = `ליד ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await expect(row).toBeVisible();

  await row.locator('[data-column-type="status"] button[data-cell-edit]').first().click();
  const label = page.getByTestId('popover').locator('button.label-tag').first();
  const text = (await label.textContent())!.trim();
  await label.click();
  await page.reload();
  await expect(page.locator('div.grid', { hasText: name }).first().getByText(text)).toBeVisible();

  await openNewBoard(page);
  const boardName = `בדיקה ${Date.now().toString(36)}`;
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(boardName);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'תאריך', exact: true }).click();
  await expect(page.locator('div.grid').first().getByText('תאריך')).toBeVisible();
});
