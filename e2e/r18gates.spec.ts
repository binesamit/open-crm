// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Plan feature gates across the app (r18gates, plans) and the agent mention picker
 *  1. On a plan version that lists only `docs` (no `dashboards`, `forms`, `ai`): "new dashboard" in the sidebar's
 *     "+", the form / dashboard view types, the AI column type and the board's assistant stay listed but disabled
 *     with the upgrade hint (`data-tip`); the admin gets "Upgrade" to My plan. "New doc" still works.
 *  2. The same account back on a legacy plan (no subscription): everything is enabled again.
 *  3. The @mention list shows an agent that does not act on this board, greyed, with its reason.
 * Cleans up: the subscription is removed, the plan archived, the agent / connection / boards deleted.
 */
const uid = () => Date.now().toString(36);
const api = (path: string) => `/api/v1${path}`;

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `r18g-${id}`;
  const res = await page.request.post(api('/platform/accounts'), {
    data: { name: `שערים ${id}`, slug, first_admin_email: `r18g-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת שערים');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

/** A board of the admin's account (made through the API as the admin). */
const newBoard = async (admin: Page, accountId: string) => {
  const headers = { 'x-account-id': accountId, origin: WEB_URL };
  let ws = ((await (await admin.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]?.id;
  if (!ws)
    ws = (
      (await (await admin.request.post(api('/workspaces'), { headers, data: { name: 'Main' } })).json()) as {
        id: string;
      }
    ).id;
  const board = (await (
    await admin.request.post(api('/boards'), { headers, data: { name: `Gates ${uid()}`, workspace_id: ws } })
  ).json()) as { id: string };
  return board.id;
};

/** A menu row (a native-disabled button) gated by the plan: listed, disabled, with the hint as its tooltip. */
const expectGatedRow = async (page: Page, testId: string) => {
  const row = page.getByTestId(testId).first();
  await expect(row).toBeVisible();
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute('data-tip', /.+/);
};

test('a plan without dashboards / forms / ai: the entries are disabled with the reason; legacy enables all', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const boardId = await newBoard(admin, accountId);
  let planId = '';
  try {
    const plan = (await (
      await page.request.post(api('/platform/plans'), {
        data: { name: `R18 gates ${uid()}`, version: { price_monthly: 10, limits: {}, features: ['docs'] } },
      })
    ).json()) as { id: string; current_version_id: string };
    planId = plan.id;
    expect(
      (
        await page.request.put(api(`/platform/accounts/${accountId}/subscription`), {
          data: { plan_version_id: plan.current_version_id },
        })
      ).ok(),
    ).toBe(true);

    // 1. Sidebar "+": new dashboard is listed but disabled with the hint; new doc works; "Upgrade" for the admin.
    await admin.goto(`/a/${slug}/b/${boardId}`);
    await admin.getByTestId('sidebar-add').click();
    await expectGatedRow(admin, 'add-new-dashboard');
    await expect(admin.getByTestId('add-new-doc')).toBeEnabled();
    await expect(admin.getByTestId('plan-upgrade-dashboards')).toBeVisible();
    await admin.keyboard.press('Escape');

    // Board: the "+" view menu offers form / dashboard views disabled.
    await admin.getByTestId('view-add').click();
    await expectGatedRow(admin, 'view-add-form');
    await expectGatedRow(admin, 'view-add-dashboard');
    await expect(admin.getByTestId('view-add-kanban')).toBeEnabled();
    await admin.keyboard.press('Escape');

    // The board's assistant (desktop): shown, aria-disabled with the hint; a click opens nothing.
    const assistant = admin.getByTestId('board-assistant').first();
    if (await assistant.count()) {
      await expect(assistant).toHaveAttribute('aria-disabled', 'true');
      await expect(assistant).toHaveAttribute('data-plan-gated', 'ai');
      await expect(assistant).toHaveAttribute('data-tip', /.+/);
      // aria-disabled: Playwright would wait for it to be enabled — forced, to prove the click does nothing.
      await assistant.click({ force: true });
      await expect(admin.getByTestId('assistant-panel')).toHaveCount(0);
    }

    // The add-column menu: the AI tile is disabled with the hint.
    await admin.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    const aiTile = admin.locator('[data-testid="add-column-type"][data-type="ai"]');
    if (await aiTile.count()) {
      await expect(aiTile).toHaveAttribute('aria-disabled', 'true');
      await expect(aiTile).toHaveAttribute('data-tip', /.+/);
    }
    await admin.keyboard.press('Escape');

    // 2. Legacy (no subscription): the same entries are enabled again — nothing was hidden or removed.
    await page.request.delete(api(`/platform/accounts/${accountId}/subscription`));
    await admin.reload();
    await admin.getByTestId('sidebar-add').click();
    await expect(admin.getByTestId('add-new-dashboard')).toBeEnabled();
    await expect(admin.getByTestId('plan-upgrade-dashboards')).toHaveCount(0);
    await admin.keyboard.press('Escape');
    await admin.getByTestId('view-add').click();
    await expect(admin.getByTestId('view-add-form')).toBeEnabled();
    await expect(admin.getByTestId('view-add-dashboard')).toBeEnabled();
    await admin.keyboard.press('Escape');
    const assistantAgain = admin.getByTestId('board-assistant').first();
    if (await assistantAgain.count()) await expect(assistantAgain).not.toHaveAttribute('aria-disabled', 'true');
  } finally {
    await page.request.delete(api(`/platform/accounts/${accountId}/subscription`));
    if (planId) await page.request.patch(api(`/platform/plans/${planId}`), { data: { archived: true } });
  }
});

test('the @mention list shows an agent that does not act here greyed, with its reason', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as { enabled: boolean };
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E r18gates ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const mk = async (name: string) =>
    (
      (await (await page.request.post(api('/boards'), { headers, data: { name, workspace_id: ws } })).json()) as {
        id: string;
      }
    ).id;
  const agentBoard = await mk(`R18 agent board ${tag}`);
  const otherBoard = await mk(`R18 other board ${tag}`);
  const item = (await (
    await page.request.post(api(`/boards/${otherBoard}/items`), { headers, data: { name: `Lead ${tag}` } })
  ).json()) as { id: string };
  const agentName = `שער ${tag}`;
  const agent = (await (
    await page.request.post(api('/agents'), {
      headers,
      data: {
        name: agentName,
        connection_id: connection.id,
        model: 'claude-opus-5-5',
        tools: ['get_item'],
        boards: [{ board_id: agentBoard, level: 'view' }],
        approval_mode: 'autonomous',
      },
    })
  ).json()) as { id: string };
  try {
    // The agent acts only on its own board: on the other board's item it is listed, disabled, with the reason.
    await page.goto(`/a/demo/b/${otherBoard}/i/${item.id}`);
    const card = page.getByRole('dialog', { name: `Lead ${tag}` });
    await expect(card).toBeVisible();
    const editor = card.getByTestId('rich-editor').first().locator('[contenteditable="true"]');
    await editor.click();
    await page.keyboard.type(`@${agentName.slice(0, 3)}`); // "שער" — a trailing space would end the suggestion
    const row = page.getByTestId(`mention-agent-${agent.id}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toHaveAttribute('data-disabled', 'true');
    await expect(row).toHaveAttribute('data-reason', /^(not_on_this_board|not_on_board|mention_off)$/);
    await expect(row).toHaveAttribute('data-tip', /.+/);
    // Not selectable: a click and Enter insert no mention.
    await row.click({ force: true }); // aria-disabled: forced, to prove it inserts nothing
    await page.keyboard.press('Enter');
    await expect(card.locator('.mention')).toHaveCount(0);
  } finally {
    await page.request.delete(api(`/agents/${agent.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.delete(api(`/boards/${agentBoard}`), { headers });
    await page.request.delete(api(`/boards/${otherBoard}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  }
});
