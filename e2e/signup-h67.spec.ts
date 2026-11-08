// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * Self sign-up ה6 + ה7: the owner console's first steps card (each step ✓ when done, hidden for good by "Hide"), and
 * domain join in admin → security — an account domain is verified (at once: the admin's own verified address is at
 * it) and then counts for joining.
 */
test('owner console: the first steps card ticks what is done and hides for good', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=overview');
  const card = page.getByTestId('first-steps');
  await expect(card).toBeVisible();
  // The E2E server runs with outbound email (mailpit). Registering is never a step: nothing is locked.
  await expect(card.getByTestId('first-step-registration')).toHaveCount(0);
  await expect(card.getByTestId('first-step-email')).toHaveAttribute('data-done', 'true');
  await expect(card.getByTestId('first-step-signup')).toHaveAttribute('data-done', 'false');
  await card.getByTestId('first-steps-dismiss').click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('first-steps')).toHaveCount(0);
});

test('admin → security: an account domain is verified for joining, then removed', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/security');
  const input = page.getByTestId('security-domain-input');
  await input.fill('example.com');
  await input.press('Enter');
  const row = page.locator('[data-testid="domain-join-row"][data-domain="example.com"]');
  await expect(row).toBeVisible();
  await row.getByTestId('domain-join-open').click();
  await expect(row.getByTestId('domain-join-record')).toHaveText(/^bines-domain-verification=[0-9a-f]{32}$/);
  // The signed-in admin's verified address is at example.com: verified at once, no DNS needed.
  await row.getByTestId('domain-join-check').click();
  await expect(row.getByTestId('domain-join-verified')).toBeVisible();
  await expect(row.getByTestId('domain-join-panel')).toHaveCount(0);

  await page
    .getByTestId('security-domain-chip')
    .filter({ hasText: 'example.com' })
    .getByTestId('security-domain-remove')
    .click();
  await expect(row).toHaveCount(0);
});
