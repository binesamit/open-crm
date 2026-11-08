// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, latestMail, signIn } from './helpers';
import { API_URL as API, WEB_URL } from './stack';

/**
 * licensing — the optional registration questionnaire against a local license server (docs/LICENSING.md, part C).
 * Nothing is locked without it: there is no first-run screen any more; the owner opens it from the license card's
 * "Get a free key". The E2E API runs with a throwaway test signing key (playwright.config.ts), so it is its own
 * license server: the owner points "license server" at it — the provider's key is fetched and shown — and the
 * questionnaire goes all the way: Submit → the verification email (Mailpit) → the verify page shows the key → the
 * questionnaire picks it up and installs it → the license card says Registered. Leaves the database as it found it
 * (no key, no license server, not asked).
 */
const ORIGIN = { origin: WEB_URL };

const licensing = async (page: Page) =>
  (await (await page.request.get('/api/v1/platform/licensing')).json()) as {
    registration: { status: string; ask: boolean };
    instance_id: string;
    server_key_fingerprint: string | null;
  };

test('registration from the license card: submit and get a Registered key; the provider key is shown', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const license = (await (await page.request.get('/api/v1/platform/license')).json()) as { state: string };
  test.skip(license.state !== 'none', 'a license is installed on this database — leave it alone');
  const server = (await (await page.request.get('/api/v1/platform/license-server')).json()) as {
    enabled: boolean;
    source: string;
    fingerprint: string | null;
  };
  test.skip(!server.enabled, 'the E2E API runs without LICENSE_SIGNING_KEY');

  try {
    // This installation registers with itself: saving the address fetches the server's public key.
    await page.request.patch('/api/v1/platform/licensing', { headers: ORIGIN, data: { server_url: API } });
    await page.request.post('/api/v1/platform/registration/reset', { headers: ORIGIN });
    // Both sides start clean: an earlier run on this database (or the one it was copied from) left
    // this installation registered on the server, and the reset above clears only the installation's side — the
    // server would answer instance_registered. The server's owner lets it register again.
    const { instance_id: instanceId } = (await (await page.request.get('/api/v1/platform/licensing')).json()) as {
      instance_id: string;
    };
    const earlier = (await (
      await page.request.get(`/api/v1/platform/installations?q=${encodeURIComponent(instanceId)}`)
    ).json()) as { data: { id: string; instance_id: string }[] };
    for (const row of earlier.data.filter((r) => r.instance_id === instanceId))
      expect(
        (await page.request.post(`/api/v1/platform/installations/${row.id}/release`, { headers: ORIGIN })).ok(),
      ).toBe(true);
    expect((await licensing(page)).server_key_fingerprint).toBe(server.fingerprint);

    // 1. No first-run screen: the app opens straight away.
    await page.goto('/');
    await expect(page.getByTestId('registration-gate')).toHaveCount(0);
    await expect(page.getByTestId('edition-banner')).toHaveCount(0);

    // 2. Owner console → Licensing: the license server card (the env key) and the provider's key.
    await page.goto('/owner?section=licensing');
    const serverCard = page.getByTestId('license-server');
    await expect(serverCard).toHaveAttribute('data-enabled', 'true');
    await expect(serverCard.getByTestId('license-server-source')).toHaveAttribute('data-source', 'env');
    await expect(serverCard.getByTestId('license-server-fingerprint')).toHaveText(server.fingerprint!);
    await expect(serverCard.getByTestId('license-server-remove')).toHaveCount(0);
    await expect(page.getByTestId('licensing-provider-key')).toHaveAttribute('data-fingerprint', server.fingerprint!);

    // 3. "Get a free key" opens the questionnaire; submit the answers.
    await page.getByTestId('owner-license-free').click();
    const form = page.getByTestId('owner-license-register');
    await expect(form).toHaveAttribute('data-state', 'form');
    await expect(page.getByTestId('owner-license-register-marketing')).not.toBeChecked();
    const email = `lic-${Date.now().toString(36)}@example.com`;
    await page.getByTestId('owner-license-register-company').fill('E2E Ltd');
    await page.getByTestId('owner-license-register-size-6-20').click();
    await page.getByTestId('owner-license-register-use-crm').click();
    await page.getByTestId('owner-license-register-email').fill(email);
    await page.getByTestId('owner-license-register-submit').click();
    await expect(form).toHaveAttribute('data-state', 'pending');
    await expect.poll(async () => (await licensing(page)).registration.status).toBe('pending');

    // 4. The verification link (in another tab) shows the key.
    // The token travels in the fragment since audit 2026-10-10 #22 (never in a server log or a referrer).
    const link = /https?:\/\/\S+\/register\/verify[?#]token=[\w%-]+/.exec(await latestMail(email))![0];
    const verify = await context.newPage();
    await verify.goto(link);
    await expect(verify.getByTestId('public-verify-key')).toHaveValue(/^lic1\./);
    await verify.close();

    // 5. The questionnaire picks the key up by itself and closes; the license card says Registered.
    await expect(form).toHaveCount(0, { timeout: 20_000 });
    const card = page.getByTestId('owner-license');
    await expect(card.getByTestId('owner-license-state')).toHaveAttribute('data-state', 'valid');
    await expect(card.getByTestId('owner-license-plan')).toHaveText('קהילה רשומה');
    await expect(page.getByTestId('licensing-registration')).toHaveAttribute('data-status', 'registered');
    // The license server's own lists show it.
    await expect(page.getByTestId('installation-row').filter({ hasText: email })).toBeVisible();
  } finally {
    await page.request.delete('/api/v1/platform/license', { headers: ORIGIN });
    await page.request.patch('/api/v1/platform/licensing', { headers: ORIGIN, data: { server_url: null } });
    await page.request.post('/api/v1/platform/registration/reset', { headers: ORIGIN });
  }
});
