// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * The knowledge center's own page inside the app (`/a/<slug>/help`): reached from the "?" menu, from
 * the quick help panel ("open the full knowledge center"), from the phone's drawer and the "אני" screen. Categories
 * as cards with their counts → a category's articles → an article with "did this help?" and "see also"; a search;
 * "open a support ticket" at the bottom for whoever may open one.
 */
const uid = () => Date.now().toString(36);
const origin = { origin: WEB_URL };
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** A category with two published articles for signed-in users (the owner is the platform's support owner). */
const seed = async (page: Page, id: string) => {
  const cats = await page.request.post('/api/v1/platform/support/help/categories', {
    headers: origin,
    data: { name: `מדריכים ${id}`, icon: 'board' },
  });
  expect(cats.status()).toBe(200);
  const category = ((await cats.json()) as { categories: { id: string; name: string }[] }).categories.find(
    (c) => c.name === `מדריכים ${id}`,
  )!;
  const articles: { id: string; slug: string; title: string }[] = [];
  for (const n of [1, 2]) {
    const title = `מדריך ${n} ${id}`;
    const res = await page.request.post('/api/v1/platform/support/help/articles', {
      headers: origin,
      data: {
        title,
        category_id: category.id,
        visibility: 'signed_in',
        content: doc(`הסבר מספר ${n} על ${id}`),
      },
    });
    expect(res.status()).toBe(201);
    const a = (await res.json()) as { id: string; slug: string };
    expect(
      (await page.request.post(`/api/v1/platform/support/help/articles/${a.id}/publish`, { headers: origin })).status(),
    ).toBe(200);
    articles.push({ ...a, title });
  }
  return { category, articles };
};

test('the "?" menu opens the knowledge center page: categories → a category → an article → see also; search', async ({
  page,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { category, articles } = await seed(page, id);

  await page.getByTestId('help-menu').click();
  await page.getByTestId('help-kb-page').click();
  await page.waitForURL(/\/a\/demo\/help/);
  const kb = page.getByTestId('kb-page');
  await expect(kb).toHaveAttribute('data-view', 'index');

  // The category's card counts its two articles.
  const card = kb.locator(`[data-testid="kb-category"][data-id="${category.id}"]`);
  await expect(card).toHaveAttribute('data-count', '2');
  await card.click();
  await expect(kb).toHaveAttribute('data-view', 'category');
  await expect(page).toHaveURL(new RegExp(`category=${category.id}`));
  await expect(kb.getByTestId('kb-article-row')).toHaveCount(2);

  // One article: the reader, "see also" with the other one, "did this help?".
  await kb.getByTestId('kb-article-row').filter({ hasText: articles[0]!.title }).click();
  await expect(kb).toHaveAttribute('data-view', 'article');
  await expect(kb.getByTestId('help-article')).toContainText(`הסבר מספר 1 על ${id}`);
  await expect(kb.getByTestId('kb-related-row')).toHaveCount(1);
  await expect(kb.getByTestId('kb-related-row')).toContainText(articles[1]!.title);
  await kb.getByTestId('help-helpful-yes').click();
  await expect(kb.getByTestId('help-feedback-thanks')).toBeVisible();
  await kb.getByTestId('kb-related-row').click();
  await expect(kb.getByTestId('help-article')).toContainText(`הסבר מספר 2 על ${id}`);

  // The crumbs go back to the category and to the index.
  await kb.getByTestId('kb-crumb-category').click();
  await expect(kb).toHaveAttribute('data-view', 'category');
  await kb.getByTestId('kb-crumb-home').click();
  await expect(kb).toHaveAttribute('data-view', 'index');

  // A search finds an article; opening it shows it.
  await kb.getByTestId('kb-search').fill(`מספר 2 ${id}`);
  await expect(kb).toHaveAttribute('data-view', 'search');
  await kb.getByTestId('kb-result').filter({ hasText: articles[1]!.title }).click();
  await expect(kb).toHaveAttribute('data-view', 'article');
  await expect(kb.getByTestId('help-article')).toContainText(`הסבר מספר 2 על ${id}`);

  // "Open a support ticket" at the bottom (when this person may): the ticket form, no native dialog.
  const cta = kb.getByTestId('kb-open-ticket');
  if (await cta.count()) {
    await cta.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  }

  // A link straight to an article works (the address can be shared).
  await page.goto(`/a/demo/help?article=${encodeURIComponent(articles[0]!.slug)}`);
  await expect(page.getByTestId('help-article')).toContainText(`הסבר מספר 1 על ${id}`);
});

test('the quick help panel links to the full page; the phone drawer and "אני" have it too', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);

  // The quick panel (articles for this screen) is still in the "?" menu, with a link to the full page.
  await page.getByTestId('help-menu').click();
  await page.getByTestId('help-center').click();
  await expect(page.getByTestId('help-panel')).toBeVisible();
  await page.getByTestId('help-open-kb-page').click();
  await page.waitForURL(/\/a\/demo\/help/);
  await expect(page.getByTestId('help-panel')).toHaveCount(0);
  await expect(page.getByTestId('kb-page')).toBeVisible();

  // On a phone: the drawer's list and the "אני" screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a/demo/my-work');
  await page.getByTestId('nav-drawer-open').click();
  await page.getByTestId('nav-help').click();
  await page.waitForURL(/\/a\/demo\/help/);
  await expect(page.getByTestId('mobile-title')).toHaveText('מרכז המידע');
  await expect(page.getByTestId('kb-page')).toBeVisible();
  // No sideways scrolling on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByTestId('bottom-nav-me').click();
  await page.getByTestId('me-help').click();
  await page.waitForURL(/\/a\/demo\/help/);
  await expect(page.getByTestId('kb-page')).toBeVisible();
});
