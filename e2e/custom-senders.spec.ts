// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * sync-sec2 (2026-10-07):
 * - S-46: a custom email sender name waits for the platform owner — the admin sees "waiting for approval", the
 *   owner approves / rejects in the owner console (with a reason), the admin sees the result.
 * - S-47: /api/v1/openapi.json is the public document; the full one answers only the platform owner.
 * Agent mentions: a new agent starts with mention on; with mention off the editor says so.
 * Every test puts the shared local account / platform back the way it found them.
 */
type Detail = { settings: { branding: Record<string, unknown> } };

test('S-46: a custom sender name waits for approval, then the owner approves or rejects it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  const platform = (await (await page.request.get('/api/v1/platform/settings')).json()) as {
    settings: { senders?: { require_approval?: boolean } };
  };
  await page.request.patch('/api/v1/platform/settings', { headers, data: { senders: { require_approval: true } } });
  const name = `Desk ${Date.now().toString(36)}`;
  try {
    await page.goto('/a/demo/admin/general');
    await expect(page.getByTestId('admin-sender-approval-note')).toBeVisible();
    await page.getByTestId('admin-sender-name-input').fill(name);
    await page.getByTestId('admin-sender-name-save').click();
    const state = page.getByTestId('admin-sender-state-email_sender_name');
    await expect(state).toHaveAttribute('data-state', 'pending');
    await expect(state).toContainText(name);
    // Not in force yet.
    const saved = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
    expect(saved.settings.branding.email_sender_name).not.toBe(name);

    // The owner console: reject with a reason.
    await page.goto('/owner?section=email');
    const row = page.getByTestId('owner-sender-row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await row.getByTestId('owner-sender-reject').click();
    await page.getByRole('dialog').getByRole('textbox').fill('Not your brand');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /דחייה|Reject/ })
      .click();
    await expect(row).toHaveCount(0);

    await page.goto('/a/demo/admin/general');
    await expect(state).toHaveAttribute('data-state', 'rejected');
    await expect(state).toContainText('Not your brand');

    // Ask again, approve: now in force.
    await page.getByTestId('admin-sender-name-input').fill(`${name} 2`);
    await page.getByTestId('admin-sender-name-save').click();
    await expect(state).toHaveAttribute('data-state', 'pending');
    await page.goto('/owner?section=email');
    const row2 = page.getByTestId('owner-sender-row').filter({ hasText: `${name} 2` });
    await row2.getByTestId('owner-sender-approve').click();
    await expect(row2).toHaveCount(0);
    const after = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
    expect(after.settings.branding.email_sender_name).toBe(`${name} 2`);
    await page.goto('/a/demo/admin/general');
    await expect(state).toHaveAttribute('data-state', 'approved');
  } finally {
    // Put the sender back while approval is off (so it applies), then the owner's setting.
    await page.request.patch('/api/v1/platform/settings', {
      headers,
      data: { senders: { require_approval: false } },
    });
    await page.request.patch('/api/v1/accounts/me', {
      headers,
      data: { settings: { branding: { email_sender_name: original.settings.branding.email_sender_name ?? null } } },
    });
    await page.request.patch('/api/v1/platform/settings', {
      headers,
      data: { senders: { require_approval: platform.settings.senders?.require_approval ?? true } },
    });
  }
});

test('S-47: the public OpenAPI document has no internal routes; the full one is for the owner', async ({
  page,
  playwright,
}) => {
  const anon = await playwright.request.newContext({ baseURL: WEB_URL });
  const pub = (await (await anon.get('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> };
  expect(Object.keys(pub.paths).some((p) => p.startsWith('/platform'))).toBe(false);
  expect((await anon.get('/api/v1/openapi.full.json')).status()).toBe(401);
  await anon.dispose();
  await signIn(page);
  const full = await page.request.get('/api/v1/openapi.full.json');
  expect(full.status()).toBe(200);
  expect(((await full.json()) as { paths: Record<string, unknown> }).paths['/platform/accounts']).toBeDefined();
});

test('agents: a new agent starts with mention on; mention off shows a note', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/agents/new');
  await page.getByTestId('agent-tab-triggers').click();
  await expect(page.getByTestId('agent-trigger-mention')).toBeChecked();
  await expect(page.getByTestId('agent-mention-off-note')).toHaveCount(0);
  await page.getByTestId('agent-trigger-mention').click();
  await expect(page.getByTestId('agent-mention-off-note')).toBeVisible();
});
