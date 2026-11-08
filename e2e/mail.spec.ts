// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * M11 stage 2 — branded emails, set in the UI: Administration → General → Emails & SMS gets the email accent
 * colour, a preview of any email (sample data, Hebrew / English, formatted / plain text) and "send a test to me".
 * The shared local account is put back the way it was found.
 */
type Detail = { settings: { branding: Record<string, unknown> } };

test('account admin: accent colour, email preview in he/en, plain text, test send', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  try {
    await page.goto('/a/demo/admin/general');
    await expect(page.getByTestId('admin-general-messaging')).toBeVisible();

    // The accent colour: only #rrggbb saves; the swatch shows it.
    await page.getByTestId('admin-email-accent-input').fill('orange');
    await expect(page.getByTestId('admin-email-accent-save')).toBeDisabled();
    await page.getByTestId('admin-email-accent-input').fill('#aa3300');
    await page.getByTestId('admin-email-accent-save').click();
    await expect(page.getByTestId('admin-email-accent-save')).toBeDisabled();
    await expect(page.getByTestId('admin-email-accent-swatch')).toHaveCSS('background-color', 'rgb(170, 51, 0)');

    // Preview: the template picker (a system menu, not a native select) and the language switch.
    await page.getByTestId('admin-email-template').click();
    await page.getByTestId('admin-email-template-notification').click();
    await page.getByTestId('admin-email-lang-en').click();
    await page.getByTestId('admin-email-preview-open').click();
    const dialog = page.getByTestId('admin-email-preview-dialog');
    await expect(dialog).toBeVisible();
    const frame = page.frameLocator('[data-testid="admin-email-preview-frame"]');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(frame.locator('td[bgcolor="#aa3300"]').first()).toBeAttached();
    // The creative look (default): a mention is drawn as a speech bubble.
    await expect(frame.locator('.bos-tint').first()).toBeAttached();
    await page.getByTestId('admin-email-view-text').click();
    await expect(page.getByTestId('admin-email-preview-text')).toContainText('--');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Hebrew reads right to left.
    await page.getByTestId('admin-email-lang-he').click();
    await page.getByTestId('admin-email-preview-open').click();
    await expect(page.frameLocator('[data-testid="admin-email-preview-frame"]').locator('html')).toHaveAttribute(
      'dir',
      'rtl',
    );
    await page.keyboard.press('Escape');

    // The classic look: the plain card, no picture.
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/accounts/me') && r.request().method() === 'PATCH',
    );
    await page.getByTestId('admin-email-style-classic').click();
    await saved;
    await page.getByTestId('admin-email-preview-open').click();
    const classic = page.frameLocator('[data-testid="admin-email-preview-frame"]');
    await expect(classic.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(classic.locator('.bos-tint')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A test to the admin's own address (local Mailpit; on staging MAIL_ALLOWLIST may report it as skipped).
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/accounts/me/email-test'));
    await page.getByTestId('admin-email-test-send').click();
    const res = await sent;
    expect([200, 503]).toContain(res.status());
    await expect(page.getByTestId('toast').first()).toBeVisible();
  } finally {
    const b = original.settings.branding;
    await page.request.patch('/api/v1/accounts/me', {
      headers,
      data: {
        settings: {
          branding: { email_accent_color: b.email_accent_color ?? null, email_style: b.email_style ?? null },
        },
      },
    });
  }
});
