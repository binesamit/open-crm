// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { MAILPIT_URL as MAILPIT } from './stack';

/** Files through real S3 (MinIO locally): a file cell on the creative board and an attachment on an update. */
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

test('upload to a file cell and attach a file to an update', async ({ page }) => {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  await page.goto('/');
  await page.getByLabel('אימייל').fill(OWNER);
  await page.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
  await expect(page.getByText('נשלח אליה קישור כניסה')).toBeVisible();
  await page.goto(/https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(OWNER))![0]);
  const join = page.getByRole('button', { name: 'הצטרפות' });
  if (await join.isVisible().catch(() => false)) await join.click();
  await page.waitForURL(/\/a\/demo/);

  await page.locator('aside a', { hasText: 'קריאייטיב' }).first().click();
  const name = `באנר ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await expect(row).toBeVisible();

  // File cell: the only cell showing "+" in a new row is the file column.
  await row.getByText('+', { exact: true }).click();
  await page
    .locator('input[type=file]:not([data-testid="avatar-input"])')
    .first()
    .setInputFiles({
      name: 'banner.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake-png-bytes'),
    });
  // An image shows as a small preview in the cell, not as a 📎 count.
  await expect(row.getByTestId('file-cell-preview')).toHaveCount(1);
  await expect(row.getByTestId('file-cell-preview')).toHaveAttribute('aria-label', 'banner.png');

  // The file's name opens the viewer (fix2); its download serves the original bytes through the signed link.
  await page.getByTestId('file-cell-open').filter({ hasText: 'banner.png' }).click();
  const viewer = page.getByTestId('file-viewer');
  await expect(viewer).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await viewer.getByTestId('file-viewer-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('banner.png');
  const fs = await import('node:fs/promises');
  expect(await fs.readFile((await download.path())!, 'utf8')).toBe('fake-png-bytes');
  await page.keyboard.press('Escape');

  // Update with an attachment.
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  await page.getByLabel(/כתבו עדכון/).fill('מצרף קובץ');
  await page
    .getByRole('dialog')
    .locator('input[type=file]:not([data-testid="avatar-input"])')
    .first()
    .setInputFiles({
      name: 'brief.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('brief'),
    });
  await expect(page.getByRole('dialog').getByText('brief.txt')).toBeVisible();
  await page.getByRole('button', { name: 'עדכון', exact: true }).click();
  await expect(
    page.locator('article').first().getByTestId('update-file').filter({ hasText: 'brief.txt' }),
  ).toBeVisible();
});
