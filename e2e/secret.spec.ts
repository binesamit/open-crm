// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';
import { enrol, totp } from './two-factor';

/**
 * Secret columns: the owner adds a secret column and sets a value; a teammate with 2FA sees "••••"
 * clicks the eye, is asked for a code (a panel, never a browser prompt), sees the value with a countdown, copies it
 * and hides it; a teammate without 2FA is told to turn it on; the column settings and the admins' secrets log.
 * The owner (no 2FA) sets a value into an empty cell (Enter saves); replacing it asks for 2FA first (the column's
 * "replace / clear needs a code", on by default); with that setting off the owner replaces and clears, and sets from the
 * item card. The teammate verifies with ONE code and Enter, and replaces a value with Enter.
 * The TOTP is computed here from the otpauth:// URI (as in sec2.spec.ts). The owner never turns 2FA on.
 * any change to a secret column's settings takes a fresh code — the owner (no 2FA) is told to turn 2FA
 * on; a teammate with 2FA is asked for the code in the settings dialog, then the settings are saved. A column created
 * with "replace / clear needs a code" off (creating a column takes no code) shows the owner's replace and clear.
 */
const PLAIN = `e2e-secret-${Date.now().toString(36)}`;

test('secret column: masked, 2FA code panel, reveal with countdown, copy, no-2FA prompt, settings and log', async ({
  page,
  browser,
}) => {
  test.setTimeout(200_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `סודות ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'pwd', title: 'סיסמה', type: 'secret' },
  });
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'pwd_open', title: 'קוד פתוח', type: 'secret', settings: { change_requires_code: false } },
  });
  /** One secret cell of a row (the board has two secret columns). */
  const secretCell = (p: Page, itemId: string, key = 'pwd') =>
    p.locator(`[data-item-id="${itemId}"] [data-column="${key}"]`).first().getByTestId('secret-cell');
  const settingsOf = async () => {
    const detail = (await (await page.request.get(`/api/v1/boards/${board.id}`, { headers })).json()) as {
      columns: { id: string; settings: Record<string, unknown> }[];
    };
    return detail.columns.find((c) => c.id === 'pwd')!.settings;
  };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'אתר לקוח' } })
  ).json()) as { id: string };
  expect(
    (await page.request.put(`/api/v1/items/${item.id}/cells/pwd/secret`, { headers, data: { value: PLAIN } })).status(),
  ).toBe(200);

  // Prod ("the secret column doesn't let me enter a value"; "I had to type 3 times"): the owner — no 2FA
  // no code — sets a value into an EMPTY cell in the table (a click anywhere on the cell) and saves it with Enter.
  const second = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'אתר שני' } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/b/${board.id}`);
  const empty = secretCell(page, second.id);
  await expect(empty.getByTestId('secret-masked')).toHaveText('');
  await empty.click({ position: { x: 20, y: 10 } });
  const edit = page.getByTestId('secret-edit-panel');
  await expect(edit).toBeVisible();
  await page.getByTestId('secret-input').fill('ui-set-value');
  await page.getByTestId('secret-input').press('Enter'); // Enter saves (it "clicked" Cancel before)
  await expect(edit).toHaveCount(0);
  await expect(empty.getByTestId('secret-masked')).toHaveText('••••••');
  await expect(page.getByTestId('secret-code-panel')).toHaveCount(0); // setting never asks for a code
  // Replacing an existing value asks for a code — the owner has no 2FA: the "turn 2FA on" panel, nothing changed.
  await empty.getByTestId('secret-masked').click();
  await page.getByTestId('secret-input').fill('ui-replaced');
  await page.getByTestId('secret-input').press('Enter');
  await expect(page.getByTestId('secret-no2fa-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(empty.getByTestId('secret-masked')).toHaveText('••••••');
  // A column with the setting off ("replace / clear needs a code"): edit rights are enough — set, replace, then clear.
  const open = secretCell(page, second.id, 'pwd_open');
  await open.click({ position: { x: 20, y: 10 } });
  await page.getByTestId('secret-input').fill('ui-open-value');
  await page.getByTestId('secret-input').press('Enter');
  await expect(open.getByTestId('secret-masked')).toHaveText('••••••');
  await open.getByTestId('secret-masked').click();
  await page.getByTestId('secret-input').fill('ui-replaced');
  await page.getByTestId('secret-input').press('Enter');
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId('secret-no2fa-panel')).toHaveCount(0);
  await open.getByTestId('secret-masked').click();
  await page.getByTestId('secret-clear').click();
  await expect(open.getByTestId('secret-masked')).toHaveText('');
  // The item card's fields tab: the same cell, the same panel.
  await page.goto(`/a/demo/b/${board.id}/i/${second.id}`);
  const card = page.getByRole('dialog', { name: 'אתר שני' });
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  const field = card.locator('[data-testid="card-field"][data-column="pwd_open"]').getByTestId('secret-cell');
  await field.click();
  await page.getByTestId('secret-input').fill('from-the-card');
  await page.getByTestId('secret-save').click();
  await expect(field.getByTestId('secret-masked')).toHaveText('••••••');
  const setLog = (await (await page.request.get('/api/v1/secrets/log?action=set', { headers })).json()) as {
    data: unknown[];
  };
  expect(setLog.data.length).toBeGreaterThanOrEqual(4); // API set + UI sets + replace + card set

  // A teammate with 2FA: masked → eye → code panel → the value with a countdown → copy → hide.
  const mate = await newTeammate(page, browser, `סוד ${Date.now().toString(36)}`);
  forbidNativeDialogs(mate);
  const uri = await enrol(mate);
  await mate.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await mate.goto(`/a/demo/b/${board.id}`);
  const cell = secretCell(mate, item.id);
  await expect(cell.getByTestId('secret-masked')).toHaveText('••••••');
  await expect(mate.getByText(PLAIN)).toHaveCount(0);
  await cell.getByTestId('secret-reveal').click();
  const panel = mate.getByTestId('secret-code-panel');
  await expect(panel).toBeVisible();
  await mate.getByTestId('secret-code').fill('000000');
  await mate.getByTestId('secret-code-submit').click();
  // A wrong code keeps the panel, with the error. Wait for the answer: while the check runs the panel ignores
  // another submit (busy), so typing the right code before the error shows lost that Enter.
  await expect(mate.getByTestId('secret-error')).toBeVisible();
  await expect(panel).toBeVisible();
  // ONE right code and Enter is enough ("I entered the code twice": Enter "clicked" Cancel before).
  await mate.getByTestId('secret-code').fill(totp(uri));
  await mate.getByTestId('secret-code').press('Enter');
  await expect(cell.getByTestId('secret-value')).toHaveText(PLAIN);
  const left = Number(await cell.getByTestId('secret-countdown').innerText());
  expect(left).toBeGreaterThan(20);
  expect(left).toBeLessThanOrEqual(30);
  await cell.getByTestId('secret-copy').click();
  // The copy is async (the click returns before the clipboard is written).
  await expect.poll(() => mate.evaluate(() => navigator.clipboard.readText())).toBe(PLAIN);
  await cell.getByTestId('secret-hide').click();
  await expect(cell.getByTestId('secret-value')).toHaveCount(0);
  // Within the verification minutes: the eye shows it again without a code.
  await cell.getByTestId('secret-reveal').click();
  await expect(cell.getByTestId('secret-value')).toHaveText(PLAIN);
  await cell.getByTestId('secret-hide').click();
  // Replacing a value with Enter: the code entered a moment ago still counts — saved, no panel; the eye shows the new one.
  await cell.getByTestId('secret-masked').click();
  await mate.getByTestId('secret-input').fill(`${PLAIN}-2`);
  await mate.getByTestId('secret-input').press('Enter');
  await expect(mate.getByTestId('secret-edit-panel')).toHaveCount(0);
  await expect(mate.getByTestId('secret-code-panel')).toHaveCount(0);
  await cell.getByTestId('secret-reveal').click();
  await expect(cell.getByTestId('secret-value')).toHaveText(`${PLAIN}-2`);

  // The owner (no 2FA) sees that a value exists and is told to turn 2FA on.
  await page.goto(`/a/demo/b/${board.id}`);
  const own = secretCell(page, item.id);
  await own.getByTestId('secret-reveal').click();
  await expect(page.getByTestId('secret-no2fa-panel')).toBeVisible();
  await expect(page.getByTestId('secret-enable-2fa')).toBeVisible();
  await page.keyboard.press('Escape');

  // The secrets log (Administration → Security) has the reveal and the copy, filtered by action.
  await page.goto('/a/demo/admin/security');
  const log = page.getByTestId('secret-log');
  await expect(log).toBeVisible();
  await expect(page.locator('[data-testid="secret-log-row"][data-action="reveal"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="secret-log-row"][data-action="copy"]').first()).toBeVisible();
  await expect(page.getByText(PLAIN)).toHaveCount(0);

  // Settings in the UI: only some people, 45 seconds, no copy. Same path as ai2 / r23ui: right-click the header →
  // the column menu's settings item.
  const openSettings = async (p: Page) => {
    await p.goto(`/a/demo/b/${board.id}`);
    await p.locator('[data-header="pwd"]').click({ button: 'right' });
    await p.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
    await expect(p.getByTestId('secret-settings')).toBeVisible();
    await p.getByTestId('secret-mode-people').click();
    await expect(p.getByTestId('column-settings-save')).toBeDisabled(); // nobody picked yet
    await p.getByTestId('secret-mode-board').click();
    await p.getByTestId('secret-seconds').fill('45');
    await p.getByTestId('secret-copy-allowed').click();
    await p.getByTestId('column-settings-save').click();
  };
  // the owner has no 2FA — told to turn it on, nothing saved.
  await openSettings(page);
  await expect(page.getByTestId('secret-settings-no2fa')).toBeVisible();
  await expect(page.getByTestId('column-settings-save')).toBeDisabled();
  expect(await settingsOf()).toMatchObject({ reveal_seconds: 30, copy_allowed: true });
  // A teammate with 2FA (no code entered yet in this session): the code field, then saved with Enter.
  const keeper = await newTeammate(page, browser, `הגדרות ${Date.now().toString(36)}`);
  forbidNativeDialogs(keeper);
  const keeperUri = await enrol(keeper);
  await openSettings(keeper);
  await expect(keeper.getByTestId('secret-settings-code')).toBeVisible();
  await keeper.getByTestId('secret-settings-code-input').fill(totp(keeperUri));
  await keeper.getByTestId('secret-settings-code-input').press('Enter');
  // Saved in the background: read until the server has it.
  await expect
    .poll(async () => {
      const st = await settingsOf();
      return { reveal_seconds: st.reveal_seconds, copy_allowed: st.copy_allowed };
    })
    .toEqual({ reveal_seconds: 45, copy_allowed: false });

  await page.request.delete(`/api/v1/boards/${board.id}`, { headers });
});
