// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Prod (product owner: "a pasted image should sit where it was put — it is hard to tie the text to the image"): an image
 * pasted into an update goes into the text at the caret, shows there after sending (loaded through the update), and
 * stays listed under the update as before (the same file — nothing stored twice). Its ✕ in the composer takes it out of
 * the text too, and (round 2) deleting it from the text takes it off the update — while writing and while editing.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const openCardOnNewBoard = async (page: Page, item: string) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תמונות ${uid()}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(item);
  await add.press('Enter');
  const r = row(page, item);
  await expect(r).toBeVisible();
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: item });
  await expect(card).toBeVisible();
  return card;
};

test('a pasted image sits in the update text where it was put, and stays listed under it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const card = await openCardOnNewBoard(page, 'צילום מסך');

  const box = card.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('לפני התמונה');
  const paste = (name: string) =>
    box.evaluate(
      (el, f) => {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], f.name, { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      { name, b64: PNG_1PX },
    );
  await paste('shot.png');
  await expect(card.getByTestId('composer-inline-image')).toHaveCount(1);
  await expect(card.getByTestId('composer-image')).toBeVisible(); // also in the attachments row

  // A second one, then its ✕: it leaves the text too.
  await paste('second.png');
  await expect(card.getByTestId('composer-inline-image')).toHaveCount(2);
  await card.getByRole('button', { name: 'הסרת הקובץ: second.png' }).click();
  await expect(card.getByTestId('composer-inline-image')).toHaveCount(1);

  // Round 2 (product owner: "removed from the update = removed completely"): a third one deleted from the text with Backspace
  // leaves the attachments too, and is not sent.
  await paste('third.png');
  await expect(card.getByTestId('composer-inline-image')).toHaveCount(2);
  await expect(card.locator('[data-testid="composer-file"][data-name="third.png"]')).toHaveCount(1);
  await card.getByTestId('composer-inline-image').nth(1).click();
  await box.press('Backspace');
  await expect(card.getByTestId('composer-inline-image')).toHaveCount(1);
  await expect(card.locator('[data-testid="composer-file"][data-name="third.png"]')).toHaveCount(0);

  await box.press('Control+End');
  await box.pressSequentially('אחרי התמונה');
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();

  const update = card.locator('article', { hasText: 'לפני התמונה' }).first();
  const body = update.locator('.update-body').first();
  // The order of the text: the line, the image, the line.
  await expect
    .poll(() => body.evaluate((el) => Array.from(el.children).map((c) => c.tagName.toLowerCase())))
    .toEqual(['p', 'figure', 'p']);
  const inline = body.getByTestId('update-email-image');
  await expect(inline).toBeVisible();
  await expect.poll(() => inline.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // Still listed under the update, once.
  await expect(update.locator('[data-testid="update-attachment"][data-name="shot.png"]')).toHaveCount(1);
  await expect(update.locator('[data-testid="update-attachment"][data-name="second.png"]')).toHaveCount(0);
  await expect(update.locator('[data-testid="update-attachment"][data-name="third.png"]')).toHaveCount(0);

  // Editing the sent update: the image deleted from the text with Backspace comes off the update on save.
  await update.getByRole('button', { name: 'פעולות לעדכון' }).click();
  await page.getByRole('menuitem', { name: 'עריכה' }).click();
  const editor = update.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await expect(update.locator('[data-testid="composer-file"][data-name="shot.png"]')).toHaveCount(1);
  await update.getByTestId('composer-inline-image').click();
  await editor.press('Backspace');
  await expect(update.locator('[data-testid="composer-file"][data-name="shot.png"]')).toHaveCount(0);
  await update.getByTestId('composer-send').click();
  await expect(body.locator('figure')).toHaveCount(0);
  await expect(update.locator('[data-testid="update-attachment"][data-name="shot.png"]')).toHaveCount(0);
});
