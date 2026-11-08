// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 22: the dashboard share dialog's email invite has "שליחה במייל" (on by default, like the
 * account invite); turned off, the guest's invitation link shows with a copy button to send another way.
 */
const uid = () => Date.now().toString(36);

test('a guest invited to a dashboard with email off gets a link to copy', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const dash = (await (
    await page.request.post(`/api/v1/workspaces/${ws}/dashboards`, { headers, data: { name: `קישור ${tag}` } })
  ).json()) as { id: string };
  try {
    await page.request.patch(`/api/v1/dashboards/${dash.id}`, { headers, data: { kind: 'shareable' } });
    await page.goto(`/a/demo/dash/${dash.id}`);
    await expect(page.getByTestId('dashboard-kind')).toHaveAttribute('data-kind', 'shareable');

    await page.getByTestId('dashboard-share-open').click();
    const invite = page.getByTestId('dashboard-invite');
    await expect(invite.getByTestId('dashboard-invite-guest')).toHaveAttribute('aria-checked', 'true');
    const sendEmail = invite.getByTestId('dashboard-invite-send-email');
    // The switch is a checkbox (role="switch"): its state is `checked`, not aria-checked.
    await expect(sendEmail).toBeChecked();
    await sendEmail.click();
    await expect(sendEmail).not.toBeChecked();

    const email = `r22-dash-link-${tag}@client.test`;
    await invite.getByTestId('dashboard-invite-emails').fill(email);
    await invite.getByTestId('dashboard-invite-send').click();
    await expect(invite.getByTestId('dashboard-invite-result')).toBeVisible();

    const row = invite.locator(`[data-testid="dashboard-invite-links-row"][data-email="${email}"]`);
    await expect(row).toBeVisible();
    const link = row.getByTestId('dashboard-invite-links-link');
    await expect(link).toHaveAttribute('data-url', /\/invite\//);
    await expect(row.getByTestId('dashboard-invite-links-link-copy')).toBeVisible();
  } finally {
    await page.request.delete(`/api/v1/dashboards/${dash.id}`, { headers });
  }
});
