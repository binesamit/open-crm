// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * (2026-10-08): one flow's runs refused by the platform (Make answered 429 / 400) → the drawer shows the
 * platform's reason as a warning, not "the tool returned an error". The platform side is faked with `page.route`; the
 * API tests (apps/api/test/flows.test.ts) cover the 200 + warning answer itself.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const FLOW = {
  id: '6976041',
  name: 'Daily leads',
  active: true,
  status: 'active',
  updated_at: null,
  last_run_at: null,
  last_run_status: null,
  errors_7d: null,
  open_url: null,
  tags: [],
};
const DETAIL = 'flow_platform_error (429): Requests limit for organization exceeded, please try again later.';

test('flowfix2: a flow whose runs the platform refused shows the reason in the runs drawer', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const conn = (await (
    await page.request.post(api('/flow-connections'), {
      headers,
      data: {
        name: `flows flowfix2 ${tag}`,
        target: { platform: 'n8n', base_url: 'https://n8n.e2e.invalid', api_key: 'e2e-key-0000-wxyz' },
      },
    })
  ).json()) as Json;
  try {
    await page.route(`**/api/v1/flow-connections/${conn.id}/flows`, (r) => r.fulfill({ json: { data: [FLOW] } }));
    await page.route(`**/api/v1/flow-connections/${conn.id}/runs?**`, (r) =>
      r.fulfill({ json: { data: [], warning: 'flow_runs_unavailable', warning_detail: DETAIL } }),
    );
    await page.goto(`/a/demo/flows?connection=${conn.id}&flow=${FLOW.id}`);
    const runs = page.getByTestId('flow-runs-dialog');
    await expect(runs).toBeVisible();
    await expect(runs.getByTestId('flow-runs-warning')).toContainText('Requests limit for organization exceeded');
    await expect(runs.getByTestId('flow-run')).toHaveCount(0);
    // The "only failed" filter answers the same way.
    await runs.getByTestId('flow-runs-errors').click();
    await expect(runs.getByTestId('flow-runs-warning')).toContainText('(429)');
  } finally {
    await page.request.delete(api(`/flow-connections/${conn.id}`), { headers });
  }
});
