// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { FAKE_MAIL_URL, INBOUND_SECRET } from './stack';

/**
 * an HTML email to an item's address shows in its update formatted — its body image (`cid:`) kept as a
 * file and shown in place, the small signature image skipped, the image from the web shown through the app, the long
 * tracking link as "קישור", hidden text gone, "show all" for a long message, and a line of what became of the files.
 * The message comes from the stand-in provider (fake-mail-provider.mjs) through a signed webhook, like Resend's.
 */
const DOMAIN = 'in.e2e.test';

/** A Svix-style signature (`v1,<base64>`) of the webhook body, with this run's secret. */
const sign = (id: string, ts: number, body: string) =>
  `v1,${createHmac('sha256', Buffer.from(INBOUND_SECRET.slice('whsec_'.length), 'base64'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64')}`;

test('an HTML email becomes a formatted update with its images', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  try {
    expect(
      (
        await page.request.patch('/api/v1/platform/settings', { headers, data: { email: { inbound_domain: DOMAIN } } })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.patch('/api/v1/accounts/me', {
          headers,
          data: {
            settings: {
              inbound_email: {
                enabled: true,
                senders: 'anyone',
                domains: [],
                body_images: true,
                body_image_min_kb: 10,
                remote_images: true,
              },
            },
          },
        })
      ).ok(),
    ).toBe(true);
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!.id;
    const board = (await (
      await page.request.post('/api/v1/boards', {
        headers,
        data: { name: `מייל HTML ${Date.now()}`, workspace_id: ws },
      })
    ).json()) as { id: string };
    const item = (await (
      await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'ניוזלטר ללקוח' } })
    ).json()) as { id: string };
    const { address } = (await (
      await page.request.post(`/api/v1/items/${item.id}/email-address`, { headers, data: {} })
    ).json()) as { address: string };

    // The message at the stand-in provider.
    const id = `e2e-${Date.now()}`;
    const tracking = 'https://links.email.news-e2e.test/CL0/https:%2F%2Fnews.test%2Fpost%2F1/1/0100019a2b3c4d5e6f';
    const filler = Array.from({ length: 30 }, (_, i) => `<p>פסקה ${i + 1} של הניוזלטר, עם עוד קצת טקסט.</p>`).join('');
    const html = `<html><head><style>p{color:red}</style></head><body>
      <div style="display:none">טקסט נסתר של תצוגה מקדימה</div>
      <h1>השבוע <b>אצלנו</b></h1>
      <p><img src="cid:hero@e2e" alt="תמונה ראשית"></p>
      <p>לפרטים: <a href="${tracking}">${tracking}</a></p>
      <img src="${FAKE_MAIL_URL}/img/banner.png" alt="באנר">
      ${filler}
      <p>תודה<br><img src="cid:sig@e2e" alt="חתימה"></p>
    </body></html>`;
    expect(
      (
        await page.request.post(`${FAKE_MAIL_URL}/__messages`, {
          data: {
            id,
            email: {
              from: 'Dana Client <dana@client-e2e.test>',
              to: [address],
              subject: 'עדכון שבועי',
              text: 'השבוע אצלנו [image: תמונה ראשית]',
              html,
              message_id: `<${id}@client-e2e.test>`,
              headers: {},
              authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
            },
            attachments: [
              {
                id: 'hero',
                filename: 'hero.png',
                content_type: 'image/png',
                content_disposition: 'inline',
                content_id: '<hero@e2e>',
                png: { w: 200, h: 100, noise: true },
              },
              {
                id: 'sig',
                filename: 'sig.png',
                content_type: 'image/png',
                content_disposition: 'inline',
                content_id: '<sig@e2e>',
                png: { w: 20, h: 10 },
              },
              {
                id: 'pdf',
                filename: 'brochure.pdf',
                content_type: 'application/pdf',
                base64: Buffer.from('%PDF-1.4 e2e').toString('base64'),
              },
            ],
          },
        })
      ).ok(),
    ).toBe(true);

    // The provider's signed notice → the API's job writes the update.
    const raw = JSON.stringify({
      type: 'email.received',
      created_at: new Date().toISOString(),
      data: { email_id: id, from: 'dana@client-e2e.test', to: [address], cc: [], received_for: [] },
    });
    const msg = `msg_${id}`;
    const ts = Math.floor(Date.now() / 1000);
    const hook = await page.request.post('/api/v1/hooks/email/resend', {
      headers: {
        'content-type': 'application/json',
        'svix-id': msg,
        'svix-timestamp': String(ts),
        'svix-signature': sign(msg, ts, raw),
      },
      data: raw,
    });
    expect(hook.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get(`/api/v1/items/${item.id}/updates`, { headers })).json()) as {
              data: unknown[];
            }
          ).data.length,
        { timeout: 30_000 },
      )
      .toBe(1);

    await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
    const card = page.getByRole('dialog', { name: 'ניוזלטר ללקוח' });
    const update = card.getByTestId('update-email').locator('xpath=ancestor::*[.//*[@data-testid="email-fold"]][1]');
    await expect(card.getByTestId('update-email')).toContainText('dana@client-e2e.test');
    // Formatted, without the hidden preview line; the long tracking link as "קישור".
    await expect(card.locator('.update-body strong', { hasText: 'אצלנו' })).toBeVisible();
    await expect(card.locator('.update-body')).not.toContainText('טקסט נסתר');
    await expect(card.locator('.update-body a', { hasText: 'קישור' })).toHaveAttribute('href', tracking);
    // The hero (a file of the update) and the banner (from the web, through the app) load in place.
    const images = card.getByTestId('update-email-image');
    await expect(images).toHaveCount(2);
    for (const img of await images.all()) {
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await img.getAttribute('src')).toMatch(/^\/api\/v1\/updates\/[^/]+\/email-images\//);
    }
    // The PDF is listed under the update; the hero is not listed again; the signature image was skipped.
    await expect(card.locator('[data-testid="update-attachment"][data-name="brochure.pdf"]')).toBeVisible();
    await expect(card.locator('[data-testid="update-attachment"][data-name="hero.png"]')).toHaveCount(0);
    await expect(card.getByTestId('update-email-files')).toContainText('קבצים שצורפו: 2');
    await expect(card.getByTestId('update-email-files')).toContainText('לא צורפו: 1');
    // Long: folded with "show all", which opens it.
    await expect(update.getByTestId('email-fold')).toHaveAttribute('data-folded', 'true');
    await update.getByTestId('email-show-all').click();
    await expect(update.getByTestId('email-fold')).not.toHaveAttribute('data-folded', 'true');
    await expect(card.locator('.update-body', { hasText: 'פסקה 30' })).toBeVisible();
    // The hero opens in the file viewer.
    await images.first().click();
    await expect(page.getByTestId('file-viewer-image')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    // Back to the defaults (off on the platform), for the other specs.
    await page.request.patch('/api/v1/platform/settings', { headers, data: { email: { inbound_domain: null } } });
  }
});
