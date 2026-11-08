// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * ANSWERS 6א.3/8/9 — what used to be fixed in code is a setting in the UI:
 * - Administration → General → Emails & SMS (sender name, Reply-To, SMS sender) and API limits;
 * - the owner console → Platform settings (product name, platform sender, SMS sender, API defaults);
 * - the token dialog → its own limits.
 * Every test puts the shared local account / platform back the way it found them.
 */
type Detail = {
  settings: { branding: Record<string, unknown>; sms: Record<string, unknown>; api_limits: Record<string, unknown> };
};

/**
 * Clicks a Save that PATCHes /accounts/me and waits for THAT save's answer — the one whose body carries `field` (prod
 *). A disabled Save button is no proof: it is disabled while the save is still on its way too, and under load
 * the next step (another save, or the read-back) overtook it.
 */
const save = async (page: Page, testId: string, field: string) => {
  const answer = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new URL(r.url()).pathname === '/api/v1/accounts/me' &&
      (r.request().postData() ?? '').includes(`"${field}"`),
  );
  await page.getByTestId(testId).click();
  expect((await answer).ok()).toBe(true);
  await expect(page.getByTestId(testId)).toBeDisabled();
};

test('account admin: email sender, Reply-To, SMS sender and API limits', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  // S-46: custom senders wait for the owner's approval — this test checks the fields, so approval is off meanwhile
  // (e2e/sec2.spec.ts covers the approval flow).
  const platform = (await (await page.request.get('/api/v1/platform/settings')).json()) as {
    settings: { senders?: { require_approval?: boolean } };
  };
  await page.request.patch('/api/v1/platform/settings', { headers, data: { senders: { require_approval: false } } });
  try {
    await page.goto('/a/demo/admin/general');
    await expect(page.getByTestId('admin-general-messaging')).toBeVisible();

    await page.getByTestId('admin-sender-name-input').fill('Smart Desk E2E');
    await save(page, 'admin-sender-name-save', 'email_sender_name');

    // A broken address cannot be saved; a good one can.
    await page.getByTestId('admin-reply-to-input').fill('not-an-address');
    await expect(page.getByTestId('admin-reply-to-save')).toBeDisabled();
    await page.getByTestId('admin-reply-to-input').fill('desk@example.com');
    await save(page, 'admin-reply-to-save', 'email_reply_to');

    await page.getByTestId('admin-sms-sender-input').fill('SmartE2E');
    await save(page, 'admin-sms-sender-save', 'sender_id');

    // API limits: out of bounds is refused in the form; a sane value saves.
    await page.getByTestId('admin-limit-token_per_minute').fill('0');
    await expect(page.getByTestId('admin-api-limits-save')).toBeDisabled();
    await page.getByTestId('admin-limit-token_per_minute').fill('120');
    await save(page, 'admin-api-limits-save', 'api_limits');

    const saved = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
    expect(saved.settings.branding).toMatchObject({
      email_sender_name: 'Smart Desk E2E',
      email_reply_to: 'desk@example.com',
    });
    expect(saved.settings.sms).toMatchObject({ sender_id: 'SmartE2E' });
    expect(saved.settings.api_limits).toMatchObject({ token_per_minute: 120 });
  } finally {
    const b = original.settings.branding;
    const l = original.settings.api_limits;
    await page.request.patch('/api/v1/accounts/me', {
      headers,
      data: {
        settings: {
          branding: { email_sender_name: b.email_sender_name ?? null, email_reply_to: b.email_reply_to ?? null },
          sms: { sender_id: original.settings.sms.sender_id ?? null },
          api_limits: {
            token_per_minute: l.token_per_minute ?? null,
            service_token_per_minute: l.service_token_per_minute ?? null,
            personal_daily: l.personal_daily ?? null,
            service_daily: l.service_daily ?? null,
          },
        },
      },
    });
    // Last: values put back while approval was still off stay in force.
    await page.request.patch('/api/v1/platform/settings', {
      headers,
      data: { senders: { require_approval: platform.settings.senders?.require_approval ?? true } },
    });
  }
});

test('a token gets its own limits in the token dialog', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const name = `limits ${Date.now().toString(36)}`;
  await page.goto('/a/demo/settings/tokens');
  await page.getByTestId('token-new').click();
  await page.getByTestId('token-name').fill(name);
  await page.getByTestId('token-create-limit-minute').fill('30');
  await page.getByTestId('token-create-confirm').click();
  await expect(page.getByTestId('token-created')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('token-created')).toHaveCount(0);
  const row = page.getByTestId('token-row').filter({ hasText: name });
  await expect(row.getByTestId('token-limits-summary')).toContainText('30');
  await row.getByTestId('token-limits').click();
  await expect(page.getByTestId('token-limits-dialog')).toBeVisible();
  await page.getByTestId('token-limit-minute').fill('');
  await page.getByTestId('token-limit-day').fill('500');
  await page.getByTestId('token-limits-save').click();
  await expect(page.getByTestId('token-limits-dialog')).toHaveCount(0);
  await expect(row.getByTestId('token-limits-summary')).toContainText('500');
  // Clean up: revoke the token through the API.
  const tokens = (await (await page.request.get('/api/v1/auth/tokens', { headers })).json()) as {
    data: { id: string; name: string }[];
  };
  const id = tokens.data.find((x) => x.name === name)?.id;
  if (id) await page.request.delete(`/api/v1/auth/tokens/${id}`, { headers });
});

test('owner console: platform settings (product name, sender, SMS, API defaults)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const before = (await (await page.request.get('/api/v1/platform/settings')).json()) as {
    settings: {
      product_name?: string;
      email: Record<string, string>;
      sms: Record<string, string>;
      api_limits: Record<string, number>;
    };
  };
  try {
    await page.goto('/owner?section=general');
    await expect(page.getByTestId('owner-platform-settings')).toBeVisible();
    await page.getByTestId('owner-product-name').fill('WorkHub E2E');
    await page.getByTestId('owner-sender-name').fill('WorkHub Team');
    await page.getByTestId('owner-sms-sender').fill('WorkHub');
    await page.getByTestId('owner-limit-token_per_minute').fill('700');
    await page.getByTestId('owner-platform-save').click();
    await expect
      .poll(
        async () => ((await (await page.request.get('/api/v1/platform/settings')).json()) as typeof before).settings,
      )
      .toMatchObject({
        product_name: 'WorkHub E2E',
        email: { sender_name: 'WorkHub Team' },
        sms: { sender_id: 'WorkHub' },
        api_limits: { token_per_minute: 700 },
      });
  } finally {
    const s = before.settings;
    await page.request.patch('/api/v1/platform/settings', {
      headers: { origin: WEB_URL },
      data: {
        product_name: s.product_name ?? null,
        email: { sender_name: s.email.sender_name ?? null, reply_to: s.email.reply_to ?? null },
        sms: { sender_id: s.sms.sender_id ?? null },
        api_limits: s.api_limits,
      },
    });
  }
});
