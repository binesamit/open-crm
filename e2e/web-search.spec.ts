// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — web search for agents, the screens: the owner's master switch (owner console → AI) and the
 * account's search service (administration → AI): a service, its key (write-only: never shown back) and the limits;
 * "ready" once the platform allows it and a key is set. Restores both settings afterwards.
 */
test('web search: the owner allows it, the admin sets a search service', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const before = (await (await page.request.get('/api/v1/platform/web-search', { headers })).json()) as {
    enabled: boolean;
  };
  const account = (await (await page.request.get('/api/v1/ai/web-search', { headers })).json()) as {
    key_set: boolean;
    provider: string | null;
    max_per_run: number;
  };

  try {
    await page.request.patch('/api/v1/platform/web-search', { headers, data: { enabled: false } });
    // Administration → AI: not allowed by the platform yet — it can be set up already.
    await page.goto('/a/demo/admin/ai');
    const card = page.getByTestId('web-search-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('בעל הפלטפורמה עדיין לא איפשר');
    await card.getByTestId('web-search-provider-tavily').click();
    await card.getByTestId('web-search-key').fill('tvly-e2e-key-0001');
    await card.getByTestId('web-search-per-run').fill('4');
    await card.getByTestId('web-search-save').click();
    await expect(card.getByTestId('web-search-key')).toHaveValue('');
    await expect(card.getByTestId('web-search-state')).toHaveAttribute('data-ready', 'no');
    await expect(page.locator('body')).not.toContainText('tvly-e2e-key-0001');

    // Owner console → AI: the master switch.
    await page.goto('/owner?section=ai-prices');
    const sw = page.getByTestId('platform-web-search');
    await expect(sw).toBeVisible();
    await sw.getByTestId('platform-web-search-switch').click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/v1/platform/web-search', { headers })).json()) as { enabled: boolean })
            .enabled,
      )
      .toBe(true);

    // Back in the account: ready.
    await page.goto('/a/demo/admin/ai');
    await expect(page.getByTestId('web-search-state')).toHaveAttribute('data-ready', 'yes');
    await expect(page.getByTestId('web-search-per-run')).toHaveValue('4');
  } finally {
    await page.request.patch('/api/v1/platform/web-search', { headers, data: { enabled: before.enabled } });
    await page.request.patch('/api/v1/ai/web-search', {
      headers,
      data: {
        max_per_run: account.max_per_run,
        ...(account.provider ? { provider: account.provider } : {}),
        ...(account.key_set ? {} : { key: null }),
      },
    });
  }
});
