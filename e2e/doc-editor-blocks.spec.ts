// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * M8 ד2–ד3 — docs, with a real keyboard and mouse: `/` inserts blocks, `@` mentions a teammate (who is notified),
 * a comment thread on a block (reply, resolve), a named version restored, export downloaded, and a doc column on a
 * board whose cell opens its doc in a side panel. Test ids only (the strings come with the i18n merge).
 */
const LIVE_MS = 5000;
const editor = (page: Page) => page.getByTestId('doc-view').locator('.ProseMirror').first();
const ready = (page: Page) =>
  expect(page.getByTestId('doc-status').first()).toHaveAttribute('data-state', 'saved', { timeout: LIVE_MS });
const uid = () => Date.now().toString(36);

/** A new doc in the first workspace (main: every member edits it), opened. */
const openNewDoc = async (page: Page, name: string, kind: 'main' | 'private' | 'shareable' = 'main') => {
  const { headers } = await ownerContext(page);
  const ws = (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] };
  const doc = (await (
    await page.request.post(`/api/v1/workspaces/${ws.data[0]!.id}/docs`, { headers, data: { name, kind } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/d/${doc.id}`);
  await ready(page);
  return doc.id;
};

test('slash menu inserts blocks; the drag handle is there', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewDoc(page, `בלוקים ${uid()}`);

  await editor(page).click();
  await page.keyboard.type('פסקה ראשונה');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByTestId('doc-slash-menu');
  await expect(menu).toBeVisible();
  // Filtering by typing, then Enter picks the first match.
  await page.keyboard.type('table');
  await expect(page.getByTestId('doc-slash-table')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(editor(page).locator('table')).toBeVisible();
  await expect(editor(page).locator('table tr')).toHaveCount(3);
  await page.keyboard.type('תא');

  // Mouse: a callout from the list.
  await editor(page).locator('p', { hasText: 'פסקה ראשונה' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.getByTestId('doc-slash-callout').click();
  await expect(editor(page).getByTestId('doc-callout')).toBeVisible();
  await page.keyboard.type('שימו לב');
  await expect(editor(page).getByTestId('doc-callout')).toContainText('שימו לב');

  // A heading through the list with arrows; Esc closes the list without inserting.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-slash-menu')).toHaveCount(0);

  await editor(page).locator('p', { hasText: 'פסקה ראשונה' }).hover();
  await expect(page.getByTestId('doc-drag-handle')).toBeVisible();
  await ready(page);
  await page.reload();
  await expect(editor(page).locator('table')).toBeVisible();
  await expect(editor(page).getByTestId('doc-callout')).toContainText('שימו לב');
});

test('@ mentions a teammate, who is notified and opens the doc from the bell', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  // One word (a space ends the `@` query) and unique (earlier runs left teammates behind).
  const mateName = `מתויגת${uid()}`;
  const mate = await newTeammate(page, browser, mateName);
  forbidNativeDialogs(mate);
  const docId = await openNewDoc(page, `תיוג ${uid()}`);

  await editor(page).click();
  await page.keyboard.type('שלום ');
  await page.keyboard.type(`@${mateName}`);
  const list = page.getByTestId('doc-mention-menu');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('doc-mention-option').first()).toContainText(mateName);
  await page.keyboard.press('Enter');
  await expect(editor(page).locator('.mention')).toContainText(mateName);
  await ready(page);

  // The bell of the mentioned person: a doc mention that opens the doc.
  await mate.goto('/a/demo');
  await expect
    .poll(
      async () => {
        await mate.reload();
        await mate.getByTestId('bell').click();
        const n = await mate.locator('[data-testid="notification"][data-type="doc_mention"]').count();
        if (!n) await mate.keyboard.press('Escape');
        return n;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  await mate.locator('[data-testid="notification"][data-type="doc_mention"]').first().click();
  await mate.waitForURL(new RegExp(`/d/${docId}`));
  await expect(editor(mate)).toContainText('שלום');
  await mate.context().close();
});

test('a comment thread on a block: write, reply from another browser, resolve', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, `מגיבה ${uid()}`);
  forbidNativeDialogs(mate);
  const docId = await openNewDoc(page, `תגובות ${uid()}`);

  await editor(page).click();
  await page.keyboard.type('הבלוק שעליו מגיבים');
  await ready(page);
  await page.getByTestId('doc-tool-comment').click();
  const draft = page.getByTestId('doc-comment-new');
  await expect(draft).toBeVisible();
  await expect(draft.getByTestId('doc-thread-quote')).toHaveText('הבלוק שעליו מגיבים');
  // The composer focuses itself once it has loaded: typed earlier, the first letter is lost.
  await expect(draft.locator('[contenteditable="true"]')).toBeFocused();
  await page.keyboard.type('צריך לנסח מחדש');
  await draft.getByTestId('doc-comment-send').click();
  const thread = page.getByTestId('doc-thread').first();
  await expect(thread.getByTestId('doc-comment-body')).toHaveText('צריך לנסח מחדש');
  await expect(page.getByTestId('doc-comment-marker')).toHaveText('1');
  await expect(page.getByTestId('doc-comments-count')).toHaveText('1');

  // The other browser: the marker on the block, the thread, a reply.
  await mate.goto(`/a/demo/d/${docId}`);
  await ready(mate);
  await mate.getByTestId('doc-comment-marker').click();
  const theirs = mate.getByTestId('doc-thread').first();
  await expect(theirs).toContainText('צריך לנסח מחדש');
  await theirs.getByTestId('doc-thread-reply').click();
  // The composer takes focus a tick after it mounts.
  await expect(theirs.locator('.ProseMirror')).toBeFocused();
  await mate.keyboard.type('מסכימה, אתקן');
  await mate.keyboard.press('Control+Enter');
  await expect(theirs.getByTestId('doc-comment')).toHaveCount(2);

  // Back here: the reply arrives live; resolve moves it to "resolved".
  await expect(thread.getByTestId('doc-comment')).toHaveCount(2, { timeout: LIVE_MS * 2 });
  await thread.getByTestId('doc-thread-resolve').click();
  await expect(page.getByTestId('doc-comments-empty')).toBeVisible();
  await expect(page.getByTestId('doc-comment-marker')).toHaveCount(0);
  await page.getByTestId('doc-comments-resolved').click();
  await expect(page.locator('[data-testid="doc-thread"][data-resolved="true"]')).toHaveCount(1);
  await mate.context().close();
});

test('version history: save a named version, change the doc, restore it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewDoc(page, `גרסאות ${uid()}`);
  await editor(page).click();
  await page.keyboard.type('הנוסח המקורי');
  await ready(page);

  const openVersions = async () => {
    await page
      .getByTestId('doc-view')
      .getByRole('button', { name: /^פעולות ל/ })
      .click();
    await page.getByTestId('doc-menu-versions').click();
    await expect(page.getByTestId('doc-versions')).toBeVisible();
  };
  await openVersions();
  await page.getByTestId('doc-version-save').click();
  await page.getByRole('dialog').last().getByRole('textbox').fill('לפני השינוי');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="doc-version"][data-label="לפני השינוי"]')).toBeVisible();
  await page.keyboard.press('Escape');

  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ועוד שינוי');
  await expect(editor(page)).toContainText('הנוסח המקורי ועוד שינוי');
  await ready(page);

  await openVersions();
  await page.locator('[data-testid="doc-version"][data-label="לפני השינוי"]').click();
  await expect(page.getByTestId('doc-version-preview')).toHaveText('הנוסח המקורי');
  await page.getByTestId('doc-version-restore').click();
  await page.getByRole('alertdialog').getByRole('button').last().click();
  // A new version on top ("↺ …"); the doc itself is back, live.
  await expect(page.getByTestId('doc-version').first()).toHaveAttribute('data-label', '↺ לפני השינוי');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveText('הנוסח המקורי', { timeout: LIVE_MS });
});

test('export downloads Markdown and HTML with the doc’s content', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `ייצוא ${uid()}`;
  await openNewDoc(page, name);
  await editor(page).click();
  await page.keyboard.type('/');
  await page.getByTestId('doc-slash-tasks').click();
  await page.keyboard.type('משימה לייצוא');
  await ready(page);

  const exportAs = async (testId: string) => {
    await page
      .getByTestId('doc-view')
      .getByRole('button', { name: /^פעולות ל/ })
      .click();
    await page.getByTestId('doc-menu-export').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(testId).click()]);
    return download;
  };
  const md = await exportAs('doc-export-md');
  expect(md.suggestedFilename()).toBe(`${name}.md`);
  const mdText = readFileSync((await md.path())!, 'utf8');
  expect(mdText).toContain(`# ${name}`);
  expect(mdText).toContain('- [ ] משימה לייצוא');

  const html = await exportAs('doc-export-html');
  expect(html.suggestedFilename()).toBe(`${name}.html`);
  const page2 = readFileSync((await html.path())!, 'utf8');
  expect(page2).toContain('dir="rtl"');
  expect(page2).toContain('משימה לייצוא');
  expect(page2).not.toContain('<script');
});

test('a doc column on a board: the cell makes the doc and opens it in a side panel', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] };
  const board = (await (
    await page.request.post('/api/v1/boards', {
      headers,
      data: { name: `אפיונים ${uid()}`, workspace_id: ws.data[0]!.id },
    })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title: 'אפיון', type: 'doc' } });
  const itemName = `פרויקט ${uid()}`;
  await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: itemName } });

  await page.goto(`/a/demo/b/${board.id}`);
  const row = page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId('doc-cell-new').click();
  const panel = page.getByTestId('doc-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('doc-title')).toHaveText(itemName);
  await expect(panel.getByTestId('doc-cell-item')).toBeVisible();
  await expect(panel.getByTestId('doc-status')).toHaveAttribute('data-state', 'saved', { timeout: LIVE_MS });
  await panel.locator('.ProseMirror').click();
  await page.keyboard.type('דרישות הלקוח');
  await expect(panel.getByTestId('doc-status')).toHaveAttribute('data-state', 'saved', { timeout: LIVE_MS });

  // Esc: the first one only leaves the editor (round 13 — typing is never cut off), the next closes the panel;
  // the cell now opens the same doc.
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.ProseMirror')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(row.getByTestId('doc-cell-open')).toContainText(itemName);
  await row.getByTestId('doc-cell-open').click();
  await expect(page.getByTestId('doc-panel').locator('.ProseMirror')).toContainText('דרישות הלקוח');
  await page.getByTestId('doc-panel-close').click();
  await expect(page.getByTestId('doc-panel')).toHaveCount(0);
});
