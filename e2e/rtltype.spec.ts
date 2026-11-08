// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * Prod fix "rtltype" (product owner: "in RTL typing must start on the right unless what is typed is English; in updates it
 * started on the left until Hebrew was typed"). The Hebrew UI: an empty update line and an empty search field are
 * rtl (caret on the right), an English line turns ltr, a Hebrew one rtl.
 */
const dirOf = (el: Locator) => el.evaluate((n) => getComputedStyle(n).direction);

test('typing starts on the UI side: update editor and board search', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();

  // Board search: empty → rtl; English → ltr; cleared → rtl again; Hebrew → rtl.
  const search = page.getByTestId('toolbar-search');
  await search.click();
  await expect.poll(() => dirOf(search)).toBe('rtl');
  await page.keyboard.type('hello');
  await expect(search).toHaveAttribute('dir', 'ltr');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(search).toHaveAttribute('dir', 'rtl');
  await page.keyboard.type('שלום');
  await expect(search).toHaveAttribute('dir', 'rtl');
  await page.keyboard.press('Escape');

  // Open an item.
  const name = `כיוון ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  const dialog = page.getByRole('dialog');

  // The update editor: the editable area and its empty line are rtl before anything is typed.
  const box = dialog.getByLabel(/כתבו עדכון/).first();
  await box.click();
  await expect(box).toHaveAttribute('dir', 'rtl');
  const lines = box.locator('p');
  await expect(lines.first()).toHaveAttribute('dir', 'rtl');
  expect(await dirOf(lines.first())).toBe('rtl');

  // English → ltr; a new (empty) line → rtl again; Hebrew there → rtl.
  await page.keyboard.type('hello');
  await expect(lines.first()).toHaveAttribute('dir', 'ltr');
  await page.keyboard.press('Enter');
  await expect(lines.nth(1)).toHaveAttribute('dir', 'rtl');
  await page.keyboard.type('שלום');
  await expect(lines.nth(1)).toHaveAttribute('dir', 'rtl');
  expect(await dirOf(lines.first())).toBe('ltr');
  expect(await dirOf(lines.nth(1))).toBe('rtl');

  // Saved: each line keeps its own direction (the stored doc has "ltr" / "rtl", not "auto").
  const saved = page.waitForRequest((r) => r.method() === 'POST' && /\/updates\b/.test(r.url()));
  await dialog.getByRole('button', { name: 'עדכון', exact: true }).click();
  const body = JSON.stringify((await saved).postDataJSON());
  expect(body).toContain('"dir":"ltr"');
  expect(body).toContain('"dir":"rtl"');

  // The composer is empty again: its line is rtl.
  await expect(box.locator('p').first()).toHaveAttribute('dir', 'rtl');
});
