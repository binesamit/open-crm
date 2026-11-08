// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * Guides: the installation and licensing guide is one click away — the help menu opens it in the app
 * (contents list, search, the other language), the license card links straight to a section of it in the owner
 * console, and its public page needs no sign-in. The owner writes a private guide in the console → it renders with
 * its own contents list → deleted again (the database is left as found).
 */
const uid = () => Date.now().toString(36);

test('help menu → the installation guide: contents, search, English', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.getByTestId('help-menu').click();
  await page.getByTestId('help-guide').click();
  await expect(page).toHaveURL(/\/a\/[^/]+\/guide/);
  const guide = page.getByTestId('install-guide');
  await expect(guide).toHaveAttribute('data-locale', 'he');
  await expect(guide.getByTestId('install-guide-body').locator('h1')).toHaveText('מדריך התקנה ורישוי');
  const toc = guide.getByTestId('install-guide-toc');
  await expect(toc).toBeVisible();
  await expect(toc.getByRole('link', { name: '7. הפעלת מפתח רישיון' })).toBeVisible();
  // Hebrew reads right to left; code blocks stay left to right.
  await expect(toc.locator('..')).toHaveAttribute('dir', 'rtl');
  await expect(guide.getByTestId('install-guide-code').first()).toHaveAttribute('dir', 'ltr');

  await guide.getByTestId('install-guide-search').fill('docker compose');
  await expect
    .poll(async () => Number(await guide.getByTestId('install-guide-hits').getAttribute('data-count')))
    .toBeGreaterThan(1);
  await guide.getByTestId('install-guide-search').fill('');

  await guide.getByTestId('install-guide-lang-en').click();
  await expect(page).toHaveURL(/locale=en/);
  await expect(guide.getByTestId('install-guide-body').locator('h1')).toHaveText('Installation and licensing guide');
  await expect(guide.getByTestId('install-guide-public')).toHaveAttribute('href', '/api/docs/guide');

  // The public page: no sign-in, its own language switch.
  const anon = await page.context().browser()!.newContext();
  const pub = await anon.newPage();
  await pub.goto('/api/docs/guide/he');
  await expect(pub.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(pub.getByTestId('install-guide').locator('h1')).toHaveText('מדריך התקנה ורישוי');
  await expect(pub.locator('aside.toc')).toBeVisible();
  await anon.close();
});

test('owner console → Guides: write a private guide, it renders, then delete it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner');
  await page.getByTestId('owner-section-guides').click();
  const section = page.getByTestId('owner-guides');
  await expect(section.getByTestId('owner-install-guide-toc')).toBeVisible();

  const title = `מדריך בדיקה ${uid()}`;
  await section.getByTestId('owner-guides-new').click();
  const editor = section.getByTestId('owner-guide-editor');
  await editor.getByTestId('owner-guide-title').fill(title);
  await editor
    .getByTestId('owner-guide-body')
    .fill('# נוהל\n\n## 1. שלב ראשון\n\nמריצים:\n\n```sh\necho ok\n```\n\n## 2. שלב שני\n\nבודקים.\n');
  await editor.getByTestId('owner-guide-preview').click();
  await expect(editor.locator('.dev-doc h2').first()).toHaveText('1. שלב ראשון');
  await editor.getByTestId('owner-guide-save').click();

  const view = section.getByTestId('owner-guide-view');
  await expect(view.locator('h3')).toHaveText(title);
  await expect(view.getByTestId('owner-guide-toc').getByRole('link')).toHaveText(['1. שלב ראשון', '2. שלב שני']);
  await expect(view.getByTestId('owner-guide-code')).toContainText('echo ok');
  const item = section.getByTestId('owner-guides-list').getByRole('button', { name: title });
  await expect(item).toBeVisible();

  // Kept on the server: a reload shows it again.
  await page.reload();
  await page.getByTestId('owner-section-guides').click();
  await section.getByTestId('owner-guides-list').getByRole('button', { name: title }).click();
  await expect(section.getByTestId('owner-guide-view').locator('h3')).toHaveText(title);

  await section.getByTestId('owner-guide-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(section.getByTestId('owner-guides-list').getByRole('button', { name: title })).toHaveCount(0);
  await expect(section.getByTestId('owner-install-guide')).toBeVisible();
});

test('license card → "how licensing works" opens the guide at the activation section', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=licensing');
  await page.getByTestId('owner-license-guide').click();
  await expect(page).toHaveURL(/section=guides/);
  await expect(page).toHaveURL(/anchor=activate/);
  const guide = page.getByTestId('owner-install-guide');
  await expect(guide).toBeVisible();
  await expect(guide.locator('[id="7-הפעלת-מפתח-רישיון"]')).toBeInViewport();
});
