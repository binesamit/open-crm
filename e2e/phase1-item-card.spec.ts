// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { MAILPIT_URL as MAILPIT } from './stack';

/** Phase 1 slice C: item card — update with a mention, reply, like, activity. */
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

test('item card: update with mention, reply, like, activity', async ({ page }) => {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  await page.goto('/');
  await page.getByLabel('אימייל').fill(OWNER);
  await page.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
  await expect(page.getByText('נשלח אליה קישור כניסה')).toBeVisible();
  await page.goto(/https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(OWNER))![0]);
  const join = page.getByRole('button', { name: 'הצטרפות' });
  if (await join.isVisible().catch(() => false)) await join.click();
  await page.waitForURL(/\/a\/demo/);

  await page.locator('aside a', { hasText: 'כרטיסי תמיכה' }).first().click();
  const name = `פנייה ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/\/i\//);

  // Update with an @mention picked from the list.
  const box = page.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('בדיקה @');
  await page.getByRole('listbox', { name: 'תיוג' }).getByRole('option').first().click();
  await box.pressSequentially('תודה');
  await page.getByRole('button', { name: 'עדכון', exact: true }).click();
  const card = page.locator('article').first();
  await expect(card.locator('.mention')).toBeVisible();
  await expect(card).toContainText('תודה');

  await card.getByRole('button', { name: 'הוספת אימוג׳י' }).first().click();
  await page.getByRole('menuitemcheckbox', { name: 'אהבתי' }).click();
  await expect(card.getByRole('button', { name: '👍 (1)' })).toHaveAttribute('aria-pressed', 'true');

  await card.getByRole('button', { name: 'תגובה' }).click();
  await page.getByLabel('כתבו תגובה…').fill('תגובה ראשונה');
  await card.getByRole('button', { name: 'תגובה' }).last().click();
  await expect(card).toContainText('תגובה ראשונה');

  await page.getByRole('dialog').getByRole('button', { name: 'פעילות', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('כתב/ה עדכון');
  await expect(page.getByRole('dialog')).toContainText('יצר/ה את הפריט');

  // Deep link survives a reload; Escape-less close via the ✕.
  await page.reload();
  await expect(page.getByRole('dialog')).toContainText(name);
  await page.getByRole('button', { name: 'סגירה' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
