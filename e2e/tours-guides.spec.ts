// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Guided tours and practical guides: a published tour is offered on the first visit
 * to its screen, runs step by step with its element lit, is recorded as done and can be run again from the "?" menu's
 * tour list; a guide shows its numbered steps with their screenshots and markers, and appears in the knowledge
 * center's "practical guides" row.
 */
const uid = () => Date.now().toString(36);
const origin = { origin: WEB_URL };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const accountId = async (page: Page) =>
  (
    (await (await page.request.get('/api/v1/me/accounts')).json()) as { data: { id: string; slug: string }[] }
  ).data.find((a) => a.slug === 'demo')!.id;

/** Earlier runs' tours on the home screen go first: this run's tour is the one offered. */
const clearTours = async (page: Page) => {
  const list = (await (await page.request.get('/api/v1/platform/support/help/tours')).json()) as { data: Json[] };
  for (const tour of list.data.filter((x) => x.title.startsWith('e2e ')))
    await page.request.delete(`/api/v1/platform/support/help/tours/${tour.id}`, { headers: origin });
};

test('a tour is offered on its screen, runs, is recorded and runs again from the list', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  await clearTours(page);
  const acc = await accountId(page);
  const title = `e2e בית ${uid()}`;
  const created = await page.request.post('/api/v1/platform/support/help/tours', {
    headers: origin,
    data: {
      title,
      route: 'home',
      steps: [
        { id: 'a', anchor: 'nav.sidebar', title: 'סרגל הצד', body: 'מכאן מגיעים לכל מקום' },
        { id: 'b', title: 'סוף', body: 'זהו' },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const tour = (await created.json()) as Json;
  expect(
    (
      await page.request.patch(`/api/v1/platform/support/help/tours/${tour.id}`, {
        headers: origin,
        data: { status: 'published', position: 0 },
      })
    ).status(),
  ).toBe(200);
  const member = { ...origin, 'x-account-id': acc };
  await page.request.put('/api/v1/support/tours/prefs', { headers: member, data: { offers: true } });
  await page.request.delete('/api/v1/support/tours/progress', { headers: member });

  await page.goto('/a/demo');
  const offer = page.getByTestId('tour-offer');
  await expect(offer).toContainText(title);
  await page.getByTestId('tour-offer-start').click();
  await expect(page.getByTestId('tour-count')).toContainText('1');
  await expect(page.getByTestId('tour-spotlight')).toBeVisible();
  await page.getByTestId('tour-next').click();
  // The last step points at nothing: the bubble stands in the middle.
  await expect(page.getByTestId('tour-spotlight')).toHaveCount(0);
  await page.getByTestId('tour-finish').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(offer).toHaveCount(0);
  await expect
    .poll(async () => {
      const mine = (await (await page.request.get('/api/v1/support/tours', { headers: member })).json()) as Json;
      return (mine.tours as Json[]).find((x) => x.id === tour.id)?.state;
    })
    .toBe('done');

  // The list of all tours: finished, and "again" runs it.
  await page.getByTestId('help-menu').click();
  await page.getByTestId('help-tours').click();
  await page.waitForURL(/\/a\/demo\/tours/);
  const row = page.getByTestId('tours-row').filter({ hasText: title });
  await expect(row).toHaveAttribute('data-state', 'done');
  await row.getByTestId('tours-run').click();
  await page.waitForURL(/\/a\/demo$/);
  await expect(page.getByTestId('tour-count')).toContainText(title);
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  await page.request.delete(`/api/v1/platform/support/help/tours/${tour.id}`, { headers: origin });
});

test('a practical guide shows its steps with their screenshots and markers, in the "practical guides" row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  // A 1×1 PNG (the same bytes are stored once: fine for the test).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const up = await page.request.post('/api/v1/platform/support/help/assets', {
    headers: origin,
    multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: png } },
  });
  expect(up.status()).toBe(201);
  const shot = (await up.json()) as Json;
  const res = await page.request.post('/api/v1/platform/support/help/articles', {
    headers: origin,
    data: {
      title: `מדריך e2e ${id}`,
      kind: 'guide',
      visibility: 'signed_in',
      guide: {
        steps: [
          { text: `פותחים את ההגדרות ${id}`, image_id: shot.id, marker: { x: 0.25, y: 0.5 } },
          { text: 'שומרים' },
        ],
      },
    },
  });
  expect(res.status()).toBe(201);
  const article = (await res.json()) as Json;
  expect(
    (
      await page.request.post(`/api/v1/platform/support/help/articles/${article.id}/publish`, { headers: origin })
    ).status(),
  ).toBe(200);

  await page.goto('/a/demo/help');
  const card = page.locator(`[data-testid="kb-guide"][data-id="${article.id}"]`);
  await expect(card).toBeVisible();
  await card.click();
  const view = page.getByTestId('help-article');
  await expect(view).toHaveAttribute('data-kind', 'guide');
  await expect(view.getByTestId('guide-step')).toHaveCount(2);
  await expect(view.getByTestId('guide-step').first()).toContainText(`פותחים את ההגדרות ${id}`);
  const marker = view.getByTestId('guide-marker');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute('style', /left: 25%/);

  await page.request.delete(`/api/v1/platform/support/help/articles/${article.id}`, { headers: origin });
});
