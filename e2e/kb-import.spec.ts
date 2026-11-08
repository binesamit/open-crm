// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * kb-import: articles are uploaded from the UI. The owner opens Support → Knowledge → "Import", picks
 * .md files and their image through the system file picker, sees the preview (nothing saved), imports, sees the report;
 * the published article shows its image to anyone on the public help center; importing again changes nothing; an
 * image is added in the editor with the image button; "Export" downloads a .zip.
 */
const uid = () => Date.now().toString(36);

/** A 2×2 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWM8AQQMQMDEAAUAMKYDJOk+9mYAAAAASUVORK5CYII=',
  'base64',
);

const article = (id: string, extra = '') =>
  Buffer.from(
    [
      '---',
      `title: ייבוא מהממשק ${id}`,
      `slug: ui-import-${id}`,
      'locale: he',
      'tags: [import-e2e]',
      'visibility: public',
      'publish: true',
      '---',
      '',
      `## שלבים ${id}`,
      '',
      '1. לוחצים על **ייבוא**',
      '2. בוחרים קבצים',
      '',
      `![צילום מסך](images/shot-${id}.png)`,
      extra,
    ].join('\n'),
  );

test('import .md + image from the UI → preview → import → public article with its image → re-import unchanged → export', async ({
  page,
}) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const files = [
    { name: `ui-import-${id}.md`, mimeType: 'text/markdown', buffer: article(id) },
    { name: `shot-${id}.png`, mimeType: 'image/png', buffer: PNG },
  ];

  await page.goto('/owner?section=support');
  await page.getByTestId('support-tab-knowledge').click();
  await expect(page.getByTestId('help-console')).toHaveAttribute('data-role', 'owner');

  // Preview: nothing saved yet.
  await page.getByTestId('help-import').click();
  await expect(page.getByTestId('help-import-dialog')).toBeVisible();
  await page.getByTestId('help-import-input').setInputFiles(files);
  const report = page.getByTestId('help-import-report');
  await expect(report).toHaveAttribute('data-dry-run', 'true');
  await expect(page.getByTestId('help-import-count-new')).toHaveAttribute('data-count', '1');
  await expect(page.locator('[data-testid="help-import-file"][data-outcome="new"]')).toHaveCount(1);
  await expect(page.locator(`[data-testid="help-article-row"][data-title="ייבוא מהממשק ${id}"]`)).toHaveCount(0);

  // Import → the report, then the article is in the list, published.
  await page.getByTestId('help-import-run').click();
  await expect(report).toHaveAttribute('data-dry-run', 'false');
  await expect(page.getByTestId('help-import-count-published')).toHaveAttribute('data-count', '1');
  await page.getByTestId('help-import-close').click();
  const row = page.locator(`[data-testid="help-article-row"][data-title="ייבוא מהממשק ${id}"]`);
  await expect(row).toHaveAttribute('data-status', 'published');

  // The editor shows the image; the image button adds another one.
  await row.click();
  const body = page.getByTestId('help-body');
  await expect(body.getByTestId('help-image')).toHaveCount(1);
  await body.locator('[contenteditable="true"]').click();
  await page.keyboard.press('Control+End');
  await page.getByTestId('help-image-input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: PNG });
  await expect(body.getByTestId('help-image')).toHaveCount(2);
  await expect(page.getByTestId('help-image-uploading')).toHaveCount(0);

  // Anyone reads it on the public help center, image included (served through the public redirect).
  const reader = await page.context().browser()!.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const anon = await reader.newPage();
  await anon.goto(`/help?article=ui-import-${id}`);
  const img = anon.locator('figure.rich-image img');
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(2);
  await reader.close();

  // The same files again: unchanged.
  await page.getByTestId('help-import').click();
  await page.getByTestId('help-import-input').setInputFiles(files);
  await expect(page.getByTestId('help-import-count-unchanged')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('help-import-run')).toBeDisabled();
  await page.getByTestId('help-import-close').click();

  // Export: a .zip download.
  const download = page.waitForEvent('download');
  await page.getByTestId('help-export').click();
  expect((await download).suggestedFilename()).toMatch(/^help-center-.*\.zip$/);
});
