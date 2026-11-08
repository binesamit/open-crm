// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * s37market: the extension developer guide inside the app — Administration → Extensions → For developers → the guide
 * in the app shell, with a table of contents, search within the page, copy buttons on code and LTR content; the
 * links between the guide and the quickstart stay in the app; the public pages stay where they were.
 */
test('the developer guide opens inside the app with contents, search and copy buttons', async ({ page, context }) => {
  forbidNativeDialogs(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  await page.goto('/a/demo/admin/extensions');
  await page.getByTestId('ext-tab-dev').click();
  // The public pages are still linked.
  await expect(page.getByTestId('ext-dev-guide')).toHaveAttribute('href', '/api/docs/extensions');

  await page.getByTestId('ext-dev-open-guide').click();
  await expect(page).toHaveURL(/\/a\/demo\/admin\/extensions\/docs\/guide$/);
  // Inside the admin shell, under Extensions.
  await expect(page.getByTestId('admin-nav-extensions')).toHaveAttribute('aria-current', 'page');
  const body = page.getByTestId('dev-docs-body');
  await expect(body.locator('h1')).toContainText('developer guide');
  // English content reads left to right inside the Hebrew app.
  await expect(page.locator('[data-testid="dev-docs-body"]').locator('xpath=..')).toHaveAttribute('dir', 'ltr');

  // Table of contents → the section.
  const toc = page.getByTestId('dev-docs-toc');
  await expect(toc).toBeVisible();
  await toc.locator('a').nth(1).click();
  await expect(page).toHaveURL(/#.+$/);

  // Search within the page.
  await page.getByTestId('dev-docs-search').fill('createBinesSdk');
  const hits = page.getByTestId('dev-docs-hits');
  await expect(hits).not.toHaveAttribute('data-count', '0');
  await expect(body.locator('mark[data-doc-hit]').first()).toBeVisible();
  await page.getByTestId('dev-docs-next').click();
  await expect(body.locator('mark[data-doc-hit][data-current]')).toHaveCount(1);
  await page.getByTestId('dev-docs-search').fill('zzzz-no-such-text');
  await expect(hits).toHaveAttribute('data-count', '0');
  await page.getByTestId('dev-docs-search').fill('');
  await expect(body.locator('mark[data-doc-hit]')).toHaveCount(0);

  // A copy button on every code block copies the code.
  const code = page.getByTestId('dev-docs-code').first();
  await code.hover();
  await code.getByTestId('dev-docs-copy').click();
  // Windows' clipboard hands multi-line text back with \r\n; the code block has \n.
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  expect(copied.length).toBeGreaterThan(0);
  expect(await code.locator('code').textContent()).toBe(copied);

  // The quickstart tab, and a link from the guide to the quickstart, stay in the app.
  await page.getByTestId('dev-docs-tab-quickstart').click();
  await expect(page).toHaveURL(/\/admin\/extensions\/docs\/quickstart$/);
  await expect(body.locator('h1')).toContainText('Quickstart');
  await page.getByTestId('dev-docs-tab-guide').click();
  await body.locator('a[href="/api/docs/extensions/quickstart"]').first().click();
  await expect(page).toHaveURL(/\/admin\/extensions\/docs\/quickstart/);

  // The public page of the same guide opens in a new tab.
  const [pub] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('dev-docs-public').click()]);
  await expect(pub).toHaveURL(/\/api\/docs\/extensions\/quickstart$/);
  await expect(pub.getByTestId('ext-docs')).toBeVisible();

  // Back to the extensions admin.
  await page.getByTestId('dev-docs-back').click();
  await expect(page.getByTestId('ext-admin')).toBeVisible();
});
