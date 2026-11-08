// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * The pricing page (canvas variant A): the owner writes the plans' marketing fields and an add-on
 * turns the page on in the owner console; a visitor (signed out) sees /pricing and the calculator changes every
 * figure with the people, the interval, an add-on and VAT; the page passes the accessibility scan (light, dark,
 * phone). Restores the page's switch and removes what it made.
 */
const uid = () => Date.now().toString(36);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const scan = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const v = r.violations.map((x) => ({
    page: name,
    id: x.id,
    help: x.help,
    at: x.nodes.slice(0, 3).map((n) => n.html),
  }));
  expect(v, JSON.stringify(v, null, 1)).toEqual([]);
};

test('the owner sets up the pricing page; a visitor uses the calculator', async ({ page, browser }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const before = (await (await page.request.get('/api/v1/platform/pricing-page')).json()) as { enabled: boolean };
  const created: { plans: string[]; addon: string | null } = { plans: [], addon: null };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  try {
    const pro = (await (
      await page.request.post('/api/v1/platform/plans', {
        data: {
          name: `מקצועי ${id}`,
          sort: 9000,
          version: {
            price_monthly: 85,
            price_yearly: 828,
            vat_included: false,
            pricing: 'per_seat',
            trial_days: 14,
            limits: { storage_gb: 100 },
          },
        },
      })
    ).json()) as { id: string };
    created.plans.push(pro.id);
    const addon = (await (
      await page.request.post('/api/v1/platform/plan-addons', {
        data: {
          name: `אחסון ${id}`,
          limit_kind: 'storage_gb',
          unit_amount: 100,
          price_monthly: 29,
          price_yearly: 290,
          vat_included: false,
          plan_ids: [pro.id],
        },
      })
    ).json()) as { id: string };
    created.addon = addon.id;

    // Owner console → Plans: the plan's marketing fields, then the pricing page's switch.
    await page.goto('/owner?section=plans');
    // The card's header carries the test id; its buttons are in the card around it.
    const card = page.locator(`[data-testid="plan-card"][data-name="מקצועי ${id}"]`).locator('xpath=..');
    await card.getByTestId('plan-edit').click();
    const dialog = page.getByTestId('plan-dialog');
    await dialog.getByTestId('plan-highlights').fill('API ו־MCP\nתוספים ופלואו');
    await dialog.getByTestId('plan-recommended').check();
    await dialog.getByTestId('plan-save').click();
    await expect(dialog).toBeHidden();
    const pageCard = page.getByTestId('pricing-page-card');
    await expect(pageCard).toBeVisible();
    if (!before.enabled) {
      const saved = page.waitForResponse(
        (r) => r.url().includes('/platform/pricing-page') && r.request().method() === 'PATCH',
      );
      await pageCard.getByTestId('pricing-page-switch').click();
      expect((await saved).ok()).toBe(true);
    }

    // A visitor (signed out).
    const visitor = await context.newPage();
    forbidNativeDialogs(visitor);
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await visitor.goto('/pricing');
    const plan = visitor.getByTestId(`pricing-plan-${pro.id}`);
    await expect(plan).toBeVisible();
    await expect(plan).toContainText('מומלץ');
    await expect(plan).toContainText('API ו־MCP');
    // 5 people, yearly: 828 / 12 = 69 → 345 a month.
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}-unit`)).toHaveText('₪69');
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}-total`)).toContainText('₪345');
    await visitor.getByTestId('pricing-interval-month').click();
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}-unit`)).toHaveText('₪85');
    await visitor.getByTestId('pricing-seats').fill('10');
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}-total`)).toContainText('₪850');
    await visitor.getByTestId(`pricing-addon-${addon.id}-more`).click();
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}-total`)).toContainText('₪879');
    await visitor.getByTestId('pricing-vat').check();
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}-unit`)).toHaveText('₪100');
    await expect(visitor.getByTestId('pricing-compare')).toBeVisible();

    await scan(visitor, 'pricing:light');
    await visitor.evaluate(() => localStorage.setItem('bines:theme', 'dark'));
    await visitor.reload();
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}`)).toBeVisible();
    await scan(visitor, 'pricing:dark');
    await visitor.evaluate(() => localStorage.removeItem('bines:theme'));
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.reload();
    await expect(visitor.getByTestId(`pricing-plan-${pro.id}`)).toBeVisible();
    // No sideways scroll on a phone.
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await scan(visitor, 'pricing:phone');
  } finally {
    await context.close();
    if (!before.enabled) await page.request.patch('/api/v1/platform/pricing-page', { data: { enabled: false } });
    if (created.addon) await page.request.delete(`/api/v1/platform/plan-addons/${created.addon}`);
    for (const p of created.plans) await page.request.delete(`/api/v1/platform/plans/${p}`);
  }
});
