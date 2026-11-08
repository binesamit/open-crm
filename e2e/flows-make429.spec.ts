// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * (2026-10-08, round 2): Make's per-organization limit. The flows list arrives without per-flow stats
 * (`stats_pending`), the screen asks `…/flows/stats` for the active flows on screen, a few at a time, and when the
 * platform limited us it says so with the time it retries; "refresh" asks again. The API side is faked with
 * `page.route`; apps/api/test/flows-limits.test.ts covers the cache, the backoff, the budget and the pacing.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const flow = (id: string, active = true): Json => ({
  id,
  name: `Scenario ${id}`,
  active,
  status: active ? 'active' : 'inactive',
  updated_at: null,
  last_run_at: null,
  last_run_status: null,
  errors_7d: null,
  open_url: null,
  tags: [],
  ...(active ? { stats_pending: true } : {}),
});

test('make429: stats load lazily for the active flows on screen; a platform limit shows when it retries', async ({
  page,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const conn = (await (
    await page.request.post(api('/flow-connections'), {
      headers,
      data: {
        name: `flows make429 ${tag}`,
        target: { platform: 'n8n', base_url: 'https://n8n.e2e.invalid', api_key: 'e2e-key-0000-wxyz' },
      },
    })
  ).json()) as Json;
  const asked: string[][] = [];
  let listCalls = 0;
  let refreshed = false;
  const until = new Date(Date.now() + 5 * 60_000).toISOString();
  try {
    await page.route(`**/api/v1/flow-connections/${conn.id}/flows?refresh=1`, (r) => {
      refreshed = true;
      return r.fulfill({
        json: { data: [flow('1'), flow('2'), flow('3', false)], fetched_at: new Date().toISOString(), limited: null },
      });
    });
    await page.route(`**/api/v1/flow-connections/${conn.id}/flows`, (r) => {
      listCalls += 1;
      return r.fulfill({
        json: { data: [flow('1'), flow('2'), flow('3', false)], fetched_at: new Date().toISOString(), limited: null },
      });
    });
    await page.route(`**/api/v1/flow-connections/${conn.id}/flows/stats`, async (r) => {
      const ids = (r.request().postDataJSON() as { flow_ids: string[] }).flow_ids;
      asked.push(ids);
      // The first scenario loads; Make then says "too many requests".
      return r.fulfill({
        json: {
          data: ids.includes('1')
            ? {
                '1': { last_run_at: new Date().toISOString(), last_run_status: 'error', errors_7d: 2, status: 'error' },
              }
            : {},
          pending: ids.filter((x) => x !== '1'),
          limited: {
            until,
            by: 'platform',
            reason: 'flow_platform_error (429): Requests limit for organization exceeded',
          },
        },
      });
    });
    await page.goto(`/a/demo/flows?connection=${conn.id}`);
    // `flows-table` is the panel's head (its title and buttons); the rows are in `flows-rows`, the limit notice beside it.
    const panel = page.getByTestId('flows-table');
    const table = page.getByTestId('flows-rows');
    await expect(table.getByTestId('flow-row')).toHaveCount(3);
    // Only the active flows were asked for.
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0]).toEqual(['1', '2']);
    const first = table.locator('[data-testid="flow-row"][data-flow-id="1"]');
    await expect(first.getByTestId('flow-errors')).toHaveText('2');
    await expect(first).toHaveAttribute('data-status', 'error');
    await expect(table.locator('[data-flow-id="2"]').getByTestId('flow-stats-pending')).toBeVisible();
    // The limit, with its time.
    await expect(page.getByTestId('flow-limited')).toHaveAttribute('data-by', 'platform');
    // In plain words — the account's limit, shared with whatever else uses it — the platform's own
    // text in the tooltip.
    await expect(page.getByTestId('flow-limited')).toContainText('הגבילה את החשבון');
    await expect(page.getByTestId('flow-limited')).toHaveAttribute('title', /Requests limit for organization exceeded/);
    // While limited, nothing more is asked.
    await page.waitForTimeout(1500);
    expect(asked).toHaveLength(1);
    // Reopening the screen does not re-ask the list (the browser keeps it a while, the server longer).
    expect(listCalls).toBe(1);
    await panel.getByTestId('flows-refresh').click();
    await expect.poll(() => refreshed).toBe(true);
  } finally {
    await page.request.delete(api(`/flow-connections/${conn.id}`), { headers });
  }
});
