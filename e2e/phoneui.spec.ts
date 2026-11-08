// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Phone click actions: the number opens a menu of the column's actions (WhatsApp, Telegram
 * call, SMS, copy, edit); Ctrl+click runs the default action; the profile preference changes what a click does;
 * the SMS dialog previews with a dry run and sends; the column's switch turns it all off (plain tel: link).
 * window.open is recorded instead of opening tabs.
 */

type Fixture = { boardId: string; phoneCol: string; tgCol: string; itemName: string; headers: Record<string, string> };

const setup = async (page: Page, tag: string): Promise<Fixture> => {
  const { headers } = await ownerContext(page);
  // Defaults for this user: the menu; WhatsApp in the browser on a computer.
  await page.request.put('/api/v1/me/phone-actions', {
    headers,
    data: { click: null, whatsapp_desktop: 'web', sms_mobile: null },
  });
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `phoneui ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const col = async (title: string, type: string) =>
    (await (
      await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title, type } })
    ).json()) as { id: string; settings: Record<string, unknown> };
  const phone = await col('טלפון', 'phone');
  const tg = await col('טלגרם', 'text');
  await page.request.patch(`/api/v1/boards/${board.id}/columns/${phone.id}`, {
    headers,
    data: {
      settings: {
        ...phone.settings,
        click_actions_enabled: true,
        actions: ['whatsapp', 'telegram', 'call', 'sms', 'copy'],
        default_action: 'whatsapp',
        telegram_username_column: tg.id,
      },
    },
  });
  const itemName = `לקוח ${tag}`;
  await page.request.post(`/api/v1/boards/${board.id}/items`, {
    headers,
    data: { name: itemName, cells: { [phone.id]: { phone: '050-123-4567' }, [tg.id]: '@bines_test' } },
  });
  return { boardId: board.id, phoneCol: phone.id, tgCol: tg.id, itemName, headers };
};

const recordOpens = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = ((url?: string | URL) => {
      w.__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

const phoneLink = (page: Page, f: Fixture) =>
  page
    .locator(`[data-testid="item-row"][data-item-name="${f.itemName}"]`)
    .locator(`[data-column="${f.phoneCol}"]`)
    .getByTestId('phone-link');

test('phone menu: WhatsApp (web), Telegram by username, call panel, Ctrl+click default, edit', async ({ page }) => {
  forbidNativeDialogs(page);
  await recordOpens(page);
  await signIn(page);
  const f = await setup(page, Date.now().toString(36));
  await page.goto(`/a/demo/b/${f.boardId}`);

  const link = phoneLink(page, f);
  await expect(link).toHaveText('050-123-4567');
  await expect(link).toHaveAttribute('data-phone-menu', 'on');

  // The menu: the column's actions in its order (SMS only when the system may send — not on the local stack), edit.
  await link.click();
  const menu = page.getByTestId('phone-menu');
  await expect(menu.getByTestId('phone-action-whatsapp')).toBeVisible();
  await expect(menu.getByTestId('phone-action-telegram')).toBeVisible();
  await expect(menu.getByTestId('phone-action-call')).toBeVisible();
  await expect(menu.getByTestId('phone-action-copy')).toBeVisible();
  await expect(menu.getByTestId('phone-action-edit')).toBeVisible();
  await menu.getByTestId('phone-action-whatsapp').click();
  await expect.poll(() => opened(page)).toContain('https://web.whatsapp.com/send?phone=972501234567');

  // Telegram goes to the username of the row's Telegram column.
  await link.click();
  await page.getByTestId('phone-action-telegram').click();
  await expect.poll(() => opened(page)).toContain('https://t.me/bines_test');

  // Call on a computer: the number to copy (and a tel: link for a calling app).
  await link.click();
  await page.getByTestId('phone-action-call').click();
  await expect(page.getByTestId('phone-call-number')).toHaveText('+972501234567');
  await expect(page.getByTestId('phone-call-app')).toHaveAttribute('href', 'tel:+972501234567');
  await page.keyboard.press('Escape');

  // Ctrl+click: the column's default action (WhatsApp) at once, no menu.
  const before = (await opened(page)).length;
  await link.click({ modifiers: ['Control'] });
  await expect(page.getByTestId('phone-menu')).toHaveCount(0);
  await expect.poll(async () => (await opened(page)).length).toBe(before + 1);

  // Editing stays: "edit" in the menu opens the inline editor.
  await link.click();
  await page.getByTestId('phone-action-edit').click();
  const input = page.locator(`[data-column="${f.phoneCol}"] input[type="tel"]`);
  await expect(input).toBeVisible();
  await input.fill('*2700');
  await input.press('Enter');
  // Not a valid number now: only call and copy.
  await expect(link).toHaveText('*2700');
  await link.click();
  await expect(page.getByTestId('phone-action-call')).toBeVisible();
  await expect(page.getByTestId('phone-action-copy')).toBeVisible();
  await expect(page.getByTestId('phone-action-whatsapp')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('profile preference: a click goes straight to the call', async ({ page }) => {
  forbidNativeDialogs(page);
  await recordOpens(page);
  await signIn(page);
  const f = await setup(page, `p${Date.now().toString(36)}`);

  await page.goto('/a/demo/profile');
  await expect(page.getByTestId('phone-prefs')).toBeVisible();
  await page.getByTestId('phone-prefs-click').click();
  await page.getByTestId('phone-prefs-click-call').click();
  await expect(page.getByTestId('phone-prefs-click')).toContainText(/חיוג|call/i);

  // The click reads my preference: the board's first click waits until it has loaded (else: the menu).
  const prefsLoaded = page.waitForResponse((r) => r.url().includes('/api/v1/me/phone-actions'));
  await page.goto(`/a/demo/b/${f.boardId}`);
  await prefsLoaded;
  await phoneLink(page, f).click();
  await expect(page.getByTestId('phone-menu')).toHaveCount(0);
  await expect(page.getByTestId('phone-call-panel')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.request.put('/api/v1/me/phone-actions', { headers: f.headers, data: { click: null } });
});

test('SMS dialog: template filled by a dry run, preview, send (provider faked)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const tag = `s${Date.now().toString(36)}`;
  const f = await setup(page, tag);
  // A saved template (Administration → SMS) — filled from the item on the server.
  await page.request.patch('/api/v1/accounts/me', {
    headers: f.headers,
    data: { settings: { sms: { templates: [{ id: 'e2e_hello', name: 'שלום', text: 'שלום {item.name}' }] } } },
  });
  // The local stack has no SMS provider: say the system may send, and fake only the real send.
  await page.route('**/api/v1/sms/status', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, can_send: true, reason: null, provider_ready: true } });
  });
  let fakeSend = false;
  await page.route('**/api/v1/items/*/sms', async (route) => {
    const body = route.request().postDataJSON() as { dry_run?: boolean; text?: string };
    if (body.dry_run || !fakeSend) return route.continue();
    await route.fulfill({
      json: {
        sent: true,
        to: '+972501234567',
        text: body.text,
        segments: 1,
        provider_message_id: 'fake',
        update: null,
      },
    });
  });

  await page.goto(`/a/demo/b/${f.boardId}`);
  await phoneLink(page, f).click();
  await page.getByTestId('phone-action-sms').click();
  const dialog = page.getByTestId('sms-dialog');
  await expect(dialog).toBeVisible();

  // The template comes back filled in (dry run) and stays editable.
  await page.getByTestId('sms-template').click();
  await page.getByTestId('sms-template-e2e_hello').click();
  await expect(page.getByTestId('sms-text')).toHaveValue(`שלום ${f.itemName}`);
  await expect(page.getByTestId('sms-counter')).toHaveAttribute('data-parts', '1');

  // Preview = exactly what goes out, to which number.
  await page.getByTestId('sms-preview').click();
  await expect(page.getByTestId('sms-preview-to')).toHaveText('+972501234567');
  await expect(page.getByTestId('sms-preview-text')).toHaveText(`שלום ${f.itemName}`);

  // A real send on the local stack fails (no provider) and says why…
  await page.getByTestId('sms-send').click();
  await expect(page.getByTestId('sms-error')).toBeVisible();
  // …with the provider faked, it is sent and the dialog closes.
  fakeSend = true;
  await page.getByTestId('sms-send').click();
  await expect(dialog).toHaveCount(0);

  await page.request.patch('/api/v1/accounts/me', {
    headers: f.headers,
    data: { settings: { sms: { templates: [] } } },
  });
});

test('column switch off: the number is the plain tel: link again', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const f = await setup(page, `o${Date.now().toString(36)}`);
  await page.goto(`/a/demo/b/${f.boardId}`);
  await expect(phoneLink(page, f)).toHaveAttribute('data-phone-menu', 'on');

  // Column settings: the switch, the actions and the default; turn it off.
  await page.locator(`[data-header="${f.phoneCol}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
  await expect(page.getByTestId('phone-settings')).toBeVisible();
  await expect(page.getByTestId('phone-settings-telegram')).toContainText('טלגרם');
  await page.getByTestId('phone-settings-enabled').click();
  await page.getByTestId('column-settings-save').click();
  await expect(page.getByTestId('phone-settings')).toHaveCount(0);

  const link = phoneLink(page, f);
  await expect(link).toHaveAttribute('data-phone-menu', 'off');
  await expect(link).toHaveAttribute('href', 'tel:0501234567');
  const settings = (await (await page.request.get(`/api/v1/boards/${f.boardId}`, { headers: f.headers })).json()) as {
    columns: { id: string; settings: Record<string, unknown> }[];
  };
  expect(settings.columns.find((c) => c.id === f.phoneCol)?.settings.click_actions_enabled).toBe(false);
});

test('a number pasted any way is saved and works; one not recognised is kept with a soft mark', async ({ page }) => {
  forbidNativeDialogs(page);
  await recordOpens(page);
  await signIn(page);
  const f = await setup(page, Date.now().toString(36));
  await page.goto(`/a/demo/b/${f.boardId}`);
  const link = phoneLink(page, f);
  const edit = async (value: string) => {
    await link.click();
    await page.getByTestId('phone-action-edit').click();
    const input = page.locator(`[data-column="${f.phoneCol}"] input[type="tel"]`);
    await input.fill(value);
    await input.press('Enter');
  };

  // As copied from WhatsApp: wrapped in direction isolates, a space after the country code.
  const isolate = (s: string) => `${String.fromCharCode(0x2066)}${s}${String.fromCharCode(0x2069)}`;
  await edit(isolate('+972 54-123-4567'));
  await expect(link).toHaveText('+972 54-123-4567');
  await expect(link).toHaveAttribute('data-valid', 'true');
  await link.click();
  await page.getByTestId('phone-action-whatsapp').click();
  await expect.poll(() => opened(page)).toContain('https://web.whatsapp.com/send?phone=972541234567');

  // Without the 0: read with the column's / account's country.
  await edit('541234567');
  await expect(link).toHaveText('541234567');
  await expect(link).toHaveAttribute('data-valid', 'true');

  // Not a number it can read: saved as written, a soft mark and a tip — no error.
  await edit('שלוחה 12');
  await expect(link).toHaveText('שלוחה 12');
  await expect(link).toHaveClass(/phone-unrecognized/);
  await expect(link).toHaveAttribute('title', /לא זוהה/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
