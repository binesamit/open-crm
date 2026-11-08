// SPDX-License-Identifier: AGPL-3.0-only
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * Account admin A3 — Administration → כללי: name, logo, weekend / first day / date and time format / currency,
 * defaults for new boards (item terminology, status labels, group colours) and the system announcement banner;
 * Administration → התראות holds the account's notification defaults; API tokens live in → חיבורים.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

type Detail = {
  name: string;
  logo_url: string | null;
  settings: {
    locale: Record<string, unknown>;
    defaults: Record<string, unknown>;
    announcement: { text: string; url?: string; until?: string } | null;
  };
};

const pick = async (page: Page, testId: string, option: string | RegExp) => {
  await page.getByTestId(testId).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: option }).click();
};

/** Puts the shared local account back the way the test found it. */
const restore = async (request: APIRequestContext, headers: Record<string, string>, original: Detail) => {
  const a = original.settings.announcement;
  await request.patch('/api/v1/accounts/me', {
    headers,
    data: {
      name: original.name,
      settings: {
        locale: original.settings.locale,
        defaults: original.settings.defaults,
        announcement: a
          ? { text: a.text, ...(a.url ? { url: a.url } : {}), ...(a.until ? { until: a.until } : {}) }
          : null,
      },
    },
  });
  if (!original.logo_url) await request.delete('/api/v1/accounts/me/logo', { headers });
};

test('general settings: name, logo, dates and currency, defaults for new boards', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  try {
    await page.goto('/a/demo/admin/general');
    await expect(page.getByTestId('admin-general')).toBeVisible();
    await expect(page.getByTestId('admin-general-slug')).toHaveText('/a/demo');

    // The name.
    const name = `${original.name} A3`;
    await page.getByTestId('admin-name-input').fill(name);
    await page.getByTestId('admin-name-save').click();
    await expect(page.getByTestId('admin-name-save')).toBeDisabled();
    await expect(page.getByText(name).first()).toBeVisible();

    // The logo: an uploaded image replaces the letter mark.
    await page.getByTestId('admin-logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('admin-general-profile').locator('..').getByTestId('account-logo-img')).toBeVisible();
    await expect(page.getByTestId('admin-logo-remove')).toBeVisible();

    // Dates and currency: each control saves at once.
    await page.getByTestId('admin-weekend-sat_sun').click();
    await pick(page, 'admin-first-day', 'שני');
    await pick(page, 'admin-date-format', /^YYYY-MM-DD/);
    await page.getByTestId('admin-time-12h').click();
    await pick(page, 'admin-currency', /^USD/);
    await page.reload();
    await expect(page.getByTestId('admin-weekend-sat_sun')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('admin-first-day')).toHaveText(/שני/);
    await expect(page.getByTestId('admin-date-format')).toHaveText(/YYYY-MM-DD/);
    await expect(page.getByTestId('admin-time-12h')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('admin-currency')).toHaveText(/USD/);
    await expect(page.getByTestId('admin-name-input')).toHaveValue(name);

    // Defaults for new boards: item terminology, status labels, group colours.
    await page.getByTestId('admin-terminology-input').fill('ליד');
    await page.getByTestId('admin-terminology-save').click();
    await expect(page.getByTestId('admin-terminology-save')).toBeDisabled();

    await page.getByTestId('admin-status-edit').click();
    const editor = page.getByTestId('label-editor');
    await editor.getByTestId('label-row').first().getByRole('textbox').fill('פתוח A3');
    await editor.getByRole('button', { name: 'שמירה' }).click();
    await expect(page.getByTestId('admin-status-label').first()).toHaveAttribute('data-label', 'פתוח A3');

    await page.locator('[data-testid="admin-group-color"][data-color="green"]').click();
    await expect(page.locator('[data-testid="admin-group-color"][data-color="green"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.locator('[data-testid="admin-group-color"][data-color="purple"]').click();
    await expect(page.locator('[data-testid="admin-group-color"][data-color="purple"]')).toHaveText('2');
    await page.screenshot({ path: 'e2e/screens/admin-a3-general.png', fullPage: true });

    // A new blank board picks them up.
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!.id;
    const board = (await (
      await page.request.post('/api/v1/boards', {
        headers,
        data: { name: `ברירות מחדל ${Date.now().toString(36)}`, workspace_id: ws },
      })
    ).json()) as { id: string; item_terminology: string; groups: { color: string }[] };
    expect(board.item_terminology).toBe('ליד');
    expect(board.groups[0]!.color).toBe('green');
    const col = (await (
      await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title: 'שלב', type: 'status' } })
    ).json()) as { settings: { labels: { label: string }[] } };
    expect(col.settings.labels[0]!.label).toBe('פתוח A3');

    // Reset the group colour order.
    await page.getByTestId('admin-group-colors-reset').click();
    await expect(page.locator('[data-testid="admin-group-color"][aria-pressed="true"]')).toHaveCount(0);
  } finally {
    await restore(page.request, headers, original);
  }
});

test('phone: the general settings fit the screen', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/a/demo/admin/general');
  await expect(page.getByTestId('admin-general-defaults')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'e2e/screens/admin-a3-general.m.png', fullPage: true });
});

test('the system announcement: shown to members, closed per person, a new one shows again, expiry', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  try {
    await page.request.patch('/api/v1/accounts/me', { headers, data: { settings: { announcement: null } } });
    await page.goto('/a/demo/admin/general');
    await expect(page.getByTestId('announcement-banner')).toHaveCount(0);
    await expect(page.getByTestId('admin-announcement-save')).toBeDisabled();

    // Publish with a link; no end date.
    await page.getByTestId('admin-announcement-url').fill('not a link');
    await page.getByTestId('admin-announcement-text').fill('תחזוקה מתוכננת ביום שישי');
    await expect(page.getByTestId('admin-announcement-save')).toBeDisabled();
    await page.getByTestId('admin-announcement-url').fill('https://status.example.com');
    await page.getByTestId('admin-announcement-save').click();
    const banner = page.getByTestId('announcement-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId('announcement-text')).toHaveText('תחזוקה מתוכננת ביום שישי');
    await expect(banner.getByTestId('announcement-link')).toHaveAttribute('href', 'https://status.example.com');
    await expect(page.getByTestId('admin-announcement-status')).toContainText('מוצגת');
    await page.screenshot({ path: 'e2e/screens/admin-a3-announcement.png' });

    // An end date from the system calendar (a year ahead), then none again.
    await page.getByTestId('admin-announcement-until').click();
    await page.getByRole('button', { name: 'השנה הבאה' }).click();
    await page.getByRole('grid').getByRole('button').nth(15).click();
    await expect(page.getByTestId('admin-announcement-until')).not.toContainText('ללא תאריך סיום');
    await expect(page.getByTestId('admin-announcement-save')).toBeEnabled();
    await page.getByTestId('admin-announcement-until-clear').click();
    await expect(page.getByTestId('admin-announcement-until')).toContainText('ללא תאריך סיום');
    await expect(page.getByTestId('admin-announcement-save')).toBeDisabled();

    // A member sees it on every page; closing it is theirs alone and survives a reload.
    const mate = await newTeammate(page, browser, 'חברה רואה הודעה');
    await mate.goto('/a/demo');
    await expect(mate.getByTestId('announcement-banner')).toBeVisible();
    await mate.getByTestId('announcement-dismiss').click();
    await expect(mate.getByTestId('announcement-banner')).toHaveCount(0);
    await mate.reload();
    await expect(mate.getByTestId('profile-menu').first()).toBeVisible();
    await expect(mate.getByTestId('announcement-banner')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('announcement-banner')).toBeVisible();

    // A changed announcement shows again to who closed the last one.
    await page.getByTestId('admin-announcement-text').fill('התחזוקה נדחתה לשבוע הבא');
    await page.getByTestId('admin-announcement-save').click();
    await expect(page.getByTestId('announcement-text')).toHaveText('התחזוקה נדחתה לשבוע הבא');
    await mate.reload();
    await expect(mate.getByTestId('announcement-banner')).toBeVisible();

    // An end date that passed hides it for everyone.
    await page.request.patch('/api/v1/accounts/me', {
      headers,
      data: { settings: { announcement: { text: 'ישנה', until: '2020-01-01' } } },
    });
    await mate.reload();
    await expect(mate.getByTestId('profile-menu').first()).toBeVisible();
    await expect(mate.getByTestId('announcement-banner')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('admin-announcement-status')).toContainText('הסתיימה');

    // Removed.
    await page.getByTestId('admin-announcement-remove').click();
    await expect(page.getByTestId('admin-announcement-status')).toHaveCount(0);
    await mate.context().close();
  } finally {
    await restore(page.request, headers, original);
  }
});

test('notifications and tokens live in Administration; the old routes still work', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  // Account notification defaults: their own section; my own settings (a tab of "הפרופיל שלי", fix5) link to it.
  await page.goto('/a/demo/settings/notifications');
  await expect(page).toHaveURL(/\/profile\?tab=notifications$/);
  await expect(page.getByTestId('notif-settings')).toBeVisible();
  await expect(page.getByTestId('notif-defaults')).toHaveCount(0);
  await page.getByTestId('notif-defaults-link').click();
  await expect(page).toHaveURL(/\/admin\/notifications$/);
  await expect(page.getByTestId('admin-nav-notifications')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('notif-defaults')).toBeVisible();
  await page.getByTestId('notif-defaults-personal-link').click();
  await expect(page).toHaveURL(/\/profile\?tab=notifications$/);

  // API tokens: /settings/tokens opens my own tokens in the profile (fix5); every member's tokens and service
  // tokens stay in Administration → חיבורים.
  await page.goto('/a/demo/settings/tokens');
  await expect(page).toHaveURL(/\/profile\?tab=tokens$/);
  await expect(page.getByTestId('token-new')).toBeVisible();
  await expect(page.getByTestId('token-new-service')).toHaveCount(0);
  await expect(page.getByTestId('tokens-show-all')).toHaveCount(0);
  await page.goto('/a/demo/admin/connections');
  await expect(page.getByTestId('token-new')).toBeVisible();
  await expect(page.getByTestId('token-new-service')).toBeVisible();
  await expect(page.getByTestId('tokens-show-all')).toBeChecked();
});

test('a member keeps their own tokens page and cannot change the account', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, 'חבר בלי הגדרות');
  await mate.goto('/a/demo/settings/tokens');
  await expect(mate).toHaveURL(/\/profile\?tab=tokens$/);
  await expect(mate.getByTestId('tokens-page')).toBeVisible();
  await expect(mate.getByTestId('tokens-show-all')).toHaveCount(0);
  await mate.goto('/a/demo/settings/notifications');
  await expect(mate.getByTestId('notif-settings')).toBeVisible();
  await expect(mate.getByTestId('notif-defaults-link')).toHaveCount(0);
  const { headers } = await ownerContext(page);
  const res = await mate.request.patch('/api/v1/accounts/me', {
    headers: { 'x-account-id': headers['x-account-id']!, origin: headers.origin! },
    data: { name: 'לא שלי' },
  });
  expect(res.status()).toBe(403);
  await mate.context().close();
});
