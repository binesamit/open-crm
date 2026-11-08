// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * Support agent, phase 3: in Errors & health → Settings, the "Support agent — tools" card — a log
 * source of a provider kind is added (its token never shown again), auto-investigation is switched on with its
 * severities and daily cap, and read-only SQL is the platform owner's switch. Platform settings: a serial spec that
 * puts everything back.
 */
const settings = (page: Page) => page.request.get('/api/v1/platform/support-agent/settings');

test('support agent tools: a Railway log source, auto-investigation, the owner-only SQL switch', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const before = (await (await settings(page)).json()) as { log_sources: { id: string }[]; sql: { enabled: boolean } };
  await page.goto('/owner?section=errors');
  await page.getByTestId('errors-tab-settings').click();
  const card = page.getByTestId('support-agent-tools');
  await expect(card).toBeVisible();

  // A log source: Railway, one environment, its token.
  await card.getByTestId('support-agent-log-add').click();
  await card.getByTestId('support-agent-log-name').fill('Railway e2e');
  await card.getByTestId('support-agent-log-env').fill('env-e2e');
  await card.getByTestId('support-agent-log-token').fill('rw-e2e-token-0000');
  await card.getByTestId('support-agent-log-save').click();
  const row = card.getByTestId('support-agent-log-source').filter({ hasText: 'Railway e2e' });
  await expect(row).toBeVisible();
  await expect(card).not.toContainText('rw-e2e-token-0000');

  // Auto-investigation: on, critical + error, at most 3 a day.
  await card.getByTestId('support-agent-auto-enabled').check();
  await card.getByTestId('support-agent-auto-error').click();
  await card.getByTestId('support-agent-auto-per-day').fill('3');
  await card.getByTestId('support-agent-auto-save').click();
  await expect
    .poll(
      async () => ((await (await settings(page)).json()) as { auto: { enabled: boolean; max_per_day: number } }).auto,
    )
    .toMatchObject({ enabled: true, max_per_day: 3, severities: ['critical', 'error'] });

  // SQL: the owner's switch.
  const sql = card.getByTestId('support-agent-sql-enabled');
  await expect(sql).toBeEnabled();

  // Put everything back.
  await row.getByTestId('support-agent-log-remove').click();
  await expect(row).toHaveCount(0);
  await page.request.patch('/api/v1/platform/support-agent/settings', {
    data: { auto: { enabled: false, severities: ['critical'], max_per_day: 10 }, sql_enabled: before.sql.enabled },
  });
  const after = (await (await settings(page)).json()) as { log_sources: unknown[] };
  expect(after.log_sources).toHaveLength(before.log_sources.length);
});

test('ops tasks (): a type on a board of an account I administer, the default, then removed', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const before = (await (await settings(page)).json()) as { ops_tasks: Record<string, unknown>[] };
  await page.goto('/owner?section=errors');
  await page.getByTestId('errors-tab-settings').click();
  const ops = page.getByTestId('support-agent-ops');
  await expect(ops).toBeVisible();

  await ops.getByTestId('support-agent-ops-add').click();
  const form = ops.getByTestId('support-agent-ops-form');
  await form.getByTestId('support-agent-ops-name').fill('Code e2e');
  await form.getByTestId('support-agent-ops-when').fill('a bug that needs a code change');
  await form.getByTestId('support-agent-ops-account').click();
  await page.locator('[data-testid^="support-agent-ops-account-"]').first().click();
  await form.getByTestId('support-agent-ops-board').click();
  await page.locator('[data-testid^="support-agent-ops-board-"]').first().click();
  await form.getByTestId('support-agent-ops-default').check();
  await form.getByTestId('support-agent-ops-save').click();

  const row = ops.getByTestId('support-agent-ops-type').filter({ hasText: 'Code e2e' });
  await expect(row).toBeVisible();
  await expect
    .poll(async () => ((await (await settings(page)).json()) as { ops_tasks: { name: string }[] }).ops_tasks)
    .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Code e2e', is_default: true, missing: false })]));

  // Put it back as it was.
  await row.getByTestId('support-agent-ops-remove').click();
  await expect(row).toHaveCount(0);
  if (before.ops_tasks.length)
    await page.request.patch('/api/v1/platform/support-agent/settings', {
      data: {
        ops_tasks: before.ops_tasks.map(({ id, name, hint, account_id, board_id, group_id, is_default }) => ({
          id,
          name,
          hint,
          account_id,
          board_id,
          group_id,
          is_default,
        })),
      },
    });
});

test('support agent AI: the platform AI first, connections by account with whose budget; internal accounts', async ({
  page,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const before = (await (await settings(page)).json()) as {
    internal_accounts: { only: boolean; account_ids: string[] };
  };
  await page.goto('/owner?section=errors');
  await page.getByTestId('errors-tab-settings').click();
  const card = page.getByTestId('support-agent-settings');
  await expect(card).toBeVisible();

  // The picker: the platform's AI is the first option, marked recommended.
  await card.getByTestId('support-agent-connection').click();
  const first = page.locator('[data-testid^="support-agent-connection-"]').first();
  await expect(first).toHaveAttribute('data-testid', 'support-agent-connection-help');
  await expect(first).toContainText('⭐');
  await page.keyboard.press('Escape');

  // The marker: an account I administer, marked internal, "only internal" on — then back as it was.
  const block = card.getByTestId('support-agent-internal');
  const only = block.getByTestId('support-agent-internal-only');
  await expect(only).toBeVisible();
  await only.click();
  await expect
    .poll(
      async () =>
        ((await (await settings(page)).json()) as { internal_accounts: { only: boolean } }).internal_accounts.only,
    )
    .toBe(!before.internal_accounts.only);
  await page.request.patch('/api/v1/platform/support-agent/settings', {
    data: { internal_accounts: before.internal_accounts },
  });
});
