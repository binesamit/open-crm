// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * "First steps": "?" → "First steps" opens the checklist; a step ticks once the person really does it
 * (here: opening a board); minimized it is a pill; closing keeps it closed.
 */
const origin = { origin: WEB_URL };

test('first steps: opened from "?", ticks when a board is opened, minimizes and closes', async ({ page }) => {
  test.setTimeout(90_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const acc = accounts.data.find((a) => a.slug === 'demo')!;
  const member = { ...origin, 'x-account-id': acc.id };
  await page.request.post('/api/v1/me/first-steps/dismiss', { headers: member, data: { dismissed: true } });

  await page.goto('/a/demo');
  await expect(page.getByTestId('first-steps')).toHaveCount(0);
  await page.getByTestId('help-menu').first().click();
  await page.getByTestId('help-first-steps').click();
  const panel = page.getByTestId('first-steps');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('first-step-joined')).toBeVisible();

  // Open a board: "open a board" ticks.
  const boards = (await (await page.request.get('/api/v1/boards', { headers: member })).json()) as {
    data: { id: string }[];
  };
  test.skip(!boards.data.length, 'no board in this database');
  await page.goto(`/a/demo/b/${boards.data[0]!.id}`);
  await expect(page.getByTestId('board-more').first()).toBeVisible();
  await page.waitForTimeout(500);
  await page.reload();
  await page.getByTestId('help-menu').first().click();
  await page.getByTestId('help-first-steps').click();
  await expect(page.getByTestId('first-step-board').getByRole('img')).toBeVisible();

  await panel.getByRole('button', { name: 'מזעור' }).click();
  await expect(page.getByTestId('first-steps-pill')).toBeVisible();
  await page.getByTestId('first-steps-pill').click();
  await page.getByTestId('first-steps-close').click();
  await expect(page.getByTestId('first-steps')).toHaveCount(0);
});
