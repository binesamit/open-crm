// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fixes (fix2, the item card): a "subitems" tab (add, open, nested levels), a long item name wraps in the
 * card's header, and the file viewer (image / PDF in place, next, download, comments on the file).
 */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, columns: string[], itemName: string) => {
  const name = `תיקון2 ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  for (const type of columns) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(itemName);
  await add.press('Enter');
  await expect(row(page, itemName)).toBeVisible();
  return name;
};

const openCard = async (page: Page, itemName: string) => {
  const r = row(page, itemName);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: itemName });
  await expect(card).toBeVisible();
  return card;
};

test('item card: a long name wraps; the subitems tab adds, nests and opens subitems', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const longName = `פריט עם שם ארוך מאוד שצריך להיראות במלואו בכותרת הכרטיס בלי לחתוך אותו באמצע ${Date.now().toString(36)}`;
  await newBoard(page, ['טקסט'], longName);
  const card = await openCard(page, longName);

  // Fix 2: the whole name shows, on more than one line, nothing cut off.
  const title = card.getByTestId('card-title');
  await expect(title).toHaveText(longName);
  const box = (await title.boundingBox())!;
  expect(box.height).toBeGreaterThan(40);
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // Fix 1: the subitems tab — add one, the tab counts it.
  await card.locator('[data-testid="card-tab"][data-tab-id="subitems"]').click();
  await expect(card.getByTestId('card-subitems')).toBeVisible();
  await card.getByTestId('card-subitem-add').first().fill('תת א');
  await card.getByTestId('card-subitem-add').first().press('Enter');
  const subA = card.locator('[data-testid="card-subitem"][data-item-name="תת א"]');
  await expect(subA).toBeVisible();
  await expect(card.getByTestId('card-subitems-count')).toHaveText('1');

  // A level deeper: ▸ opens its subitems with their own "add".
  await subA.getByTestId('card-subitem-toggle').click();
  const subId = await subA.getAttribute('data-item-id');
  const nestedAdd = card.locator(`[data-testid="card-subitem-add"][data-parent-id="${subId}"]`);
  await nestedAdd.fill('תת תת');
  await nestedAdd.press('Enter');
  await expect(card.locator('[data-testid="card-subitem"][data-item-name="תת תת"][data-depth="1"]')).toBeVisible();

  // The tab's columns are configurable in the tab settings.
  await card.getByTestId('card-tabs-settings').click();
  const dialog = page.getByTestId('card-tab-settings-dialog');
  await dialog
    .locator('[data-testid="card-tab-row"][data-id="subitems"]')
    .getByTestId('card-tab-pick-subitem-columns')
    .click();
  await expect(dialog.getByTestId('card-tab-subitems-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A subitem's name opens its own card.
  await subA.getByTestId('card-subitem-open').click();
  await expect(page.getByRole('dialog', { name: 'תת א' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/i/${subId}`));
});

test('file viewer: image and PDF open in place, next, download, a comment on the file', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['קבצים'], 'מסמכים');
  const r = row(page, 'מסמכים');
  // The only cell showing "+" in a new row is the file column.
  await r.getByText('+', { exact: true }).click();
  await page
    .locator('input[type=file]:not([data-testid="avatar-input"])')
    .first()
    .setInputFiles([
      { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') },
      { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) },
    ]);
  // The image shows as a preview; the PDF keeps the 📎 count.
  await expect(r.getByTestId('file-cell-preview')).toHaveCount(1);
  await expect(r.getByText('📎 1')).toBeVisible();

  // A file's name opens the viewer: the image in place, then → the PDF.
  await page.getByTestId('file-cell-open').first().click();
  const viewer = page.getByTestId('file-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId('file-viewer-name')).toHaveText('pixel.png');
  await expect(viewer.getByTestId('file-viewer-image')).toBeVisible();
  await viewer.getByTestId('file-viewer-next').click();
  await expect(viewer.getByTestId('file-viewer-name')).toHaveText('doc.pdf');
  await expect(viewer.getByTestId('file-viewer-pdf')).toBeVisible();
  // ← / → move between the files too.
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByTestId('file-viewer-name')).toHaveText('pixel.png');
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.getByTestId('file-viewer-name')).toHaveText('doc.pdf');

  // Download still gives the file.
  const download = page.waitForEvent('download');
  await viewer.getByTestId('file-viewer-download').click();
  expect((await download).suggestedFilename()).toBe('doc.pdf');

  // A comment on the file: shown in the viewer, and as an update on the item that names the file.
  await viewer.getByTestId('file-viewer-comment').fill('נא לחתום בעמוד 2');
  await viewer.getByTestId('file-viewer-comment-send').click();
  await expect(viewer.getByTestId('file-viewer-comment-entry')).toContainText('נא לחתום בעמוד 2');
  await expect(viewer.getByTestId('file-viewer-comment-entry')).toContainText('doc.pdf');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  const card = await openCard(page, 'מסמכים');
  await expect(card.locator('article').first()).toContainText('נא לחתום בעמוד 2');

  // Files attached to an update open in the viewer too; a comment there is a reply to that update.
  const box = card.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('צילום');
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_1PX);
  await expect(page.getByTestId('composer-image')).toBeVisible();
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();
  const update = card.locator('article', { hasText: 'צילום' }).first();
  await update.getByTestId('update-image').click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId('file-viewer-image')).toBeVisible();
  await viewer.getByTestId('file-viewer-comment').fill('חדה מאוד');
  await viewer.getByTestId('file-viewer-comment-send').click();
  await expect(viewer.getByTestId('file-viewer-comment-entry')).toContainText('חדה מאוד');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  // Esc closed only the viewer; the card is still open, with the reply under the update.
  await expect(card).toBeVisible();
  await expect(update.locator('[data-depth="1"]')).toContainText('חדה מאוד');
});
