// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Legal documents: the public pages and their links (sign-in screen, public index, language switch); the
 * owner writes a new document in the console and publishes it; an invited person joins under the "by joining you
 * agree" line and the consent is recorded; a newer version asks again (the gate) — the gate's answer is mocked so
 * no other worker's users are asked.
 */
const uid = () => Date.now().toString(36);

test('public pages: links on the sign-in screen, the index, a document in both languages', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.goto('/login');
  const links = page.getByTestId('legal-links');
  await expect(links).toBeVisible();
  await expect(page.getByTestId('legal-link-terms')).toHaveAttribute('href', '/legal/terms');
  await expect(page.getByTestId('legal-link-privacy')).toHaveAttribute('href', '/legal/privacy');

  await page.goto('/legal');
  await expect(page.getByTestId('legal-index')).toContainText('מדיניות פרטיות');
  await page.getByTestId('legal-index').getByText('מדיניות פרטיות').click();
  await expect(page).toHaveURL(/\/legal\/privacy/);
  await expect(page.getByTestId('legal-doc-title')).toHaveText('מדיניות פרטיות');
  await expect(page.getByTestId('legal-doc')).toContainText('טיוטה לבדיקת עורך דין');
  await expect(page.getByTestId('legal-toc')).toBeVisible();
  await page.getByTestId('legal-locale').getByRole('button', { name: 'English' }).click();
  await expect(page).toHaveURL(/locale=en/);
  await expect(page.getByTestId('legal-doc-title')).toHaveText('Privacy Policy');
  await expect(page.getByTestId('legal-page')).toHaveAttribute('dir', 'ltr');
});

test('owner writes and publishes a document; it is public at once, then deleted', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=legal');
  const panel = page.getByTestId('owner-legal');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByTestId('owner-legal-doc-terms')).toBeVisible();

  const slug = `e2e-${uid()}`;
  await panel.getByTestId('owner-legal-new').click();
  await panel.getByTestId('owner-legal-new-slug').fill(slug);
  await panel.getByTestId('owner-legal-new-he').fill('מסמך בדיקה');
  await panel.getByTestId('owner-legal-new-en').fill('Test document');
  await panel.getByTestId('owner-legal-new-create').click();
  const editor = panel.getByTestId('owner-legal-editor');
  await expect(editor.getByTestId('owner-legal-title')).toHaveValue('מסמך בדיקה');
  await editor.getByTestId('owner-legal-body').fill('## סעיף ראשון\n\nשלום מ-{{product_name}}.');
  await editor.getByTestId('owner-legal-lang-en').click();
  await editor.getByTestId('owner-legal-body').fill('## First section\n\nHello from {{product_name}}.');
  await editor.getByTestId('owner-legal-preview').click();
  await expect(editor.locator('.legal-content h2')).toHaveText('First section');
  await editor.getByTestId('owner-legal-publish').click();
  await expect(panel.getByTestId(`owner-legal-doc-${slug}`)).toContainText('1');

  const pub = await page.context().newPage();
  await pub.goto(`/legal/${slug}?locale=he`);
  await expect(pub.getByTestId('legal-doc-title')).toHaveText('מסמך בדיקה');
  await expect(pub.getByTestId('legal-doc')).toContainText('סעיף ראשון');
  await expect(pub.getByTestId('legal-doc')).not.toContainText('{{');
  await pub.close();

  // added documents can be deleted (two clicks); the page is gone
  await panel.getByTestId(`owner-legal-doc-${slug}`).click();
  await editor.getByTestId('owner-legal-delete').click();
  await editor.getByTestId('owner-legal-delete').click();
  await expect(panel.getByTestId(`owner-legal-doc-${slug}`)).toHaveCount(0);
  expect((await page.request.get(`/api/v1/legal/${slug}`)).status()).toBe(404);
});

test('joining agrees to the current terms (recorded); a newer version asks before going on', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const consentsOf = async () => {
    const res = await page.request.get('/api/v1/platform/legal');
    const { data } = (await res.json()) as { data: { slug: string; consents: number }[] };
    return data.find((d) => d.slug === 'privacy')!.consents;
  };
  const before = await consentsOf();

  const id = uid();
  const slug = `legal-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `משפטי ${id}`, slug, first_admin_email: `legal-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { invitation } = (await res.json()) as { invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const admin = await context.newPage();
  forbidNativeDialogs(admin);
  await admin.goto(invitation.url);
  const consent = admin.getByTestId('legal-consent');
  await expect(consent).toContainText('תנאי שימוש');
  await expect(consent).toContainText('מדיניות פרטיות');
  await expect(admin.getByTestId('legal-links')).toBeVisible();
  await admin.getByLabel('שם מלא').fill('דנה מנהלת');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  expect(await consentsOf()).toBeGreaterThan(before);
  const mine = (await (await admin.request.get('/api/v1/me/legal')).json()) as { pending: unknown[] };
  expect(mine.pending).toEqual([]);

  // A newer version (mocked for this person only): the gate shows, "continue" waits for the tick, then the app.
  const list = (await (await admin.request.get('/api/v1/legal')).json()) as {
    data: { slug: string; version: number; requires_consent: boolean }[];
  };
  const terms = list.data.find((d) => d.slug === 'terms')!;
  let pending = [terms];
  await admin.route('**/api/v1/me/legal', (r) => r.fulfill({ json: { pending } }));
  await admin.route('**/api/v1/me/legal/accept', (r) => {
    pending = [];
    return r.fulfill({ json: { pending } });
  });
  await admin.reload();
  const gate = admin.getByTestId('legal-gate');
  await expect(gate).toBeVisible();
  await expect(gate.getByTestId('legal-gate-doc-terms')).toHaveAttribute('href', '/legal/terms');
  await expect(admin.getByTestId('legal-gate-continue')).toBeDisabled();
  await admin.getByTestId('legal-gate-checkbox').check();
  await admin.getByTestId('legal-gate-continue').click();
  await expect(gate).toHaveCount(0);
  await expect(admin).toHaveURL(new RegExp(`/a/${slug}`));
  await context.close();
});
