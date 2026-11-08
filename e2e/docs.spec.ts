// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { addNew, forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * M8 ד1 — docs: a doc is created from the sidebar next to the boards, opens as a page, and two browsers edit it
 * together live (each sees the other's text and presence); a viewer reads along but cannot type.
 */
const LIVE_MS = 5000;
const editor = (page: Page) => page.getByTestId('doc-page').locator('.ProseMirror');
const ready = (page: Page) =>
  expect(page.getByTestId('doc-status')).toHaveAttribute('data-state', 'saved', { timeout: LIVE_MS });

test('two browsers edit the same doc and see each other', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  // "מסמך חדש" next to "בורד חדש": created at once, opened, and listed in the tree.
  await addNew(page, 'add-new-doc');
  await page.waitForURL(/\/a\/demo\/d\/[0-9A-Z]{26}$/);
  await expect(page.getByTestId('doc-page')).toBeVisible();
  const docId = page.url().split('/d/')[1]!;

  // Rename from the title.
  const name = `מסמך ${Date.now().toString(36)}`;
  await page.getByTestId('doc-title').click();
  await page.getByTestId('doc-title-input').fill(name);
  await page.getByTestId('doc-title-input').press('Enter');
  await expect(page.getByTestId('doc-title')).toHaveText(name);
  await expect(page.locator(`[data-testid="doc-row"][data-name="${name}"]`)).toBeVisible();

  const other = await newTeammate(page, browser, 'שותפה למסמך');
  forbidNativeDialogs(other);
  await other.goto(`/a/demo/d/${docId}`);
  await ready(page);
  await ready(other);

  await editor(page).click();
  await page.keyboard.type('שלום מהדפדפן הראשון');
  await expect(editor(other)).toContainText('שלום מהדפדפן הראשון', { timeout: LIVE_MS });

  await editor(other).click();
  await other.keyboard.press('Control+End');
  await other.keyboard.press('Enter');
  await other.keyboard.type('and hello back');
  await expect(editor(page)).toContainText('and hello back', { timeout: LIVE_MS });

  // Each sees the other here.
  await expect(page.getByTestId('doc-presence')).toHaveAttribute('data-count', '1', { timeout: LIVE_MS });
  await expect(other.getByTestId('doc-presence')).toHaveAttribute('data-count', '1', { timeout: LIVE_MS });

  // the first browser sees the block the other stands on, lit (stronger while typing), and the list says
  // where everyone is; "show where others are" off hides it, on brings it back.
  const lit = editor(page).locator('.doc-peer-block');
  await expect(lit).toHaveCount(1, { timeout: LIVE_MS });
  await expect(lit).toContainText('and hello back');
  await expect(lit).toHaveAttribute('data-peer', 'שותפה למסמך');
  await other.keyboard.type('!');
  await expect(editor(page).locator('.doc-peer-typing')).toHaveCount(1, { timeout: LIVE_MS });
  await page.getByTestId('doc-presence').click();
  await expect(page.getByTestId('doc-presence-person')).toContainText('שותפה למסמך');
  await page.getByTestId('doc-presence-person').click();
  await page.getByTestId('doc-presence').click();
  await page.getByTestId('doc-presence-show-others').click();
  await expect(lit).toHaveCount(0);
  await page.getByTestId('doc-presence-show-others').click();
  await expect(lit).toHaveCount(1, { timeout: LIVE_MS });
  await page.keyboard.press('Escape');

  // Saved: a reload shows it all.
  await ready(page);
  await other.reload();
  await expect(editor(other)).toContainText('שלום מהדפדפן הראשון');
  await expect(editor(other)).toContainText('and hello back');
  await other.context().close();
});

test('a viewer reads along live but cannot type', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const workspaces = (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as {
    data: { id: string }[];
  };
  const doc = (await (
    await page.request.post(`/api/v1/workspaces/${workspaces.data[0]!.id}/docs`, {
      headers,
      data: { name: `פרטי ${Date.now().toString(36)}`, kind: 'private' },
    })
  ).json()) as { id: string };

  const viewer = await newTeammate(page, browser, 'צופה במסמך');
  forbidNativeDialogs(viewer);
  // Not invited to a private doc: it does not exist for them.
  await viewer.goto(`/a/demo/d/${doc.id}`);
  await expect(viewer.getByTestId('doc-page-error')).toBeVisible();

  const me = ((await (await page.request.get('/api/v1/auth/me')).json()) as { user: { id: string } }).user.id;
  const them = ((await (await viewer.request.get('/api/v1/auth/me')).json()) as { user: { id: string } }).user.id;
  const put = await page.request.put(`/api/v1/docs/${doc.id}/members`, {
    headers,
    data: {
      members: [
        { type: 'user', id: me, level: 'owner' },
        { type: 'user', id: them, level: 'viewer' },
      ],
    },
  });
  expect(put.status()).toBe(200);

  await page.goto(`/a/demo/d/${doc.id}`);
  await viewer.goto(`/a/demo/d/${doc.id}`);
  await ready(page);
  await expect(viewer.getByTestId('doc-readonly')).toBeVisible({ timeout: LIVE_MS });
  await expect(editor(viewer)).toHaveAttribute('contenteditable', 'false');
  await expect(viewer.getByTestId('doc-share')).toHaveCount(0);

  await editor(page).click();
  await page.keyboard.type('רק הבעלים כותב');
  await expect(editor(viewer)).toContainText('רק הבעלים כותב', { timeout: LIVE_MS });

  // Typing does nothing for the viewer — here or for the owner.
  await editor(viewer).click();
  await viewer.keyboard.type('viewer text');
  await expect(editor(viewer)).not.toContainText('viewer text');
  await page.waitForTimeout(500);
  await expect(editor(page)).not.toContainText('viewer text');
  await viewer.context().close();
});
