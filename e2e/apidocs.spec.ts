// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

/**
 * The public API reference (/api/docs): renders from this origin under its CSP — no console errors, no request to
 * another host — with the guide and the resource navigation, and an endpoint page with its code sample.
 */
test('API reference renders offline under its CSP', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`external: ${u}`);
  });

  await page.goto('/api/docs');
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.getByText('Workspace structure').first()).toBeVisible();
  await page.getByText('Items', { exact: true }).first().click();
  await page.getByText('Create an item', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Create an item' })).toBeVisible();
  await expect(page.getByText('items:write').first()).toBeVisible();
  // The internal and owner-only parts stay out.
  await expect(page.getByText('/platform/accounts')).toHaveCount(0);
  expect(problems).toEqual([]);
});
