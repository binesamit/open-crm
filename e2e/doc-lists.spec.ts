// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Fix: — docs and the shared rich editor, with a real keyboard and mouse:
 * 1. lists in RTL: numbers / bullets / check boxes on the right in Hebrew, on the left in English;
 * 2. Tab / Shift+Tab nest and un-nest items, with the level's marker (1. → a., • → ◦);
 * 3. a click on the block's drag handle opens the block menu (turn into, duplicate, delete…);
 * 4. a right click in a doc opened from a board's doc column shows the doc's menu, never the board's;
 * 5. a check box sits on its text's line, and its author ticks it in a rendered update (saved);
 * 6. a file cell's "+" offers "new doc": a doc in the cell, opened in the side panel.
 * Test ids only (the strings come with the i18n merge).
 */
const LIVE_MS = 5000;
const uid = () => Date.now().toString(36);
const editor = (page: Page) => page.getByTestId('doc-view').locator('.ProseMirror').first();
const ready = (scope: Page | Locator) =>
  expect(scope.getByTestId('doc-status').first()).toHaveAttribute('data-state', 'saved', { timeout: LIVE_MS });
const direction = (el: Locator) => el.evaluate((n) => getComputedStyle(n).direction);
const listStyle = (el: Locator) => el.evaluate((n) => getComputedStyle(n).listStyleType);

const api = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const ws = (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] };
  return { headers, wsId: ws.data[0]!.id };
};

const openNewDoc = async (page: Page, name: string) => {
  const { headers, wsId } = await api(page);
  const doc = (await (
    await page.request.post(`/api/v1/workspaces/${wsId}/docs`, { headers, data: { name, kind: 'main' } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/d/${doc.id}`);
  await ready(page);
  return doc.id;
};

const newBoard = async (page: Page, column: { title: string; type: string }, itemName: string) => {
  const { headers, wsId } = await api(page);
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `r10 ${uid()}`, workspace_id: wsId } })
  ).json()) as { id: string };
  const col = (await (
    await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: column })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: itemName } })
  ).json()) as { id: string };
  return { headers, boardId: board.id, columnId: col.id, itemId: item.id };
};

test('lists follow their text direction; Tab nests with the level’s marker, Shift+Tab un-nests', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewDoc(page, `רשימות ${uid()}`);
  const ed = editor(page);

  // A Hebrew bullet list (markdown shortcut "- "), then Tab on its second item.
  await ed.click();
  await page.keyboard.type('- ראשון');
  await page.keyboard.press('Enter');
  await page.keyboard.type('שני');
  const outer = ed.locator('ul').first();
  await expect(outer).toBeVisible();
  expect(await direction(outer.locator('li').first())).toBe('rtl');
  // The marker is on the right: the item's text starts at its right edge, inside the list's right edge.
  const box = (await outer.locator('li').first().boundingBox())!;
  const listBox = (await outer.boundingBox())!;
  expect(listBox.x + listBox.width - (box.x + box.width)).toBeGreaterThan(8);

  await page.keyboard.press('Tab');
  const inner = outer.locator('li ul').first();
  await expect(inner).toBeVisible();
  expect(await listStyle(inner)).toBe('circle');
  // Nested toward the inline end (left in RTL).
  const innerBox = (await inner.locator('li').first().boundingBox())!;
  expect(innerBox.x + innerBox.width).toBeLessThan(box.x + box.width - 8);
  // Tab again on an item that cannot nest further stays in the editor.
  await page.keyboard.press('Tab');
  await expect(ed).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(outer.locator('li ul')).toHaveCount(0);
  await expect(outer.locator(':scope > li')).toHaveCount(2);

  // A numbered English list: markers on the left; nested level is a., b.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // out of the list
  await page.keyboard.type('1. first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  const ol = ed.locator('ol').first();
  expect(await direction(ol.locator('li').first())).toBe('ltr');
  await page.keyboard.press('Tab');
  expect(await listStyle(ol.locator('li ol').first())).toBe('lower-alpha');

  // A check list: the box on the same line as its text.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[ ] משימה');
  const taskItem = ed.locator('ul[data-type="taskList"] > li').first();
  await expect(taskItem).toBeVisible();
  expect(await direction(taskItem)).toBe('rtl');
  const label = (await taskItem.locator('label').boundingBox())!;
  const line = (await taskItem.locator('p').first().boundingBox())!;
  expect(Math.abs(label.y + label.height / 2 - (line.y + Math.min(line.height, 24) / 2))).toBeLessThan(6);
  // At the start side (right in Hebrew).
  expect(label.x).toBeGreaterThan(line.x);
  await ready(page);
});

test('the drag handle opens the block menu: turn into, duplicate, delete', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewDoc(page, `בלוק ${uid()}`);
  const ed = editor(page);
  await ed.click();
  await page.keyboard.type('בלוק אחד');
  await page.keyboard.press('Enter');
  await page.keyboard.type('בלוק שני');

  const first = ed.locator('p', { hasText: 'בלוק אחד' });
  await first.hover();
  await page.getByTestId('doc-drag-handle').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByTestId('doc-block-turn').click();
  await page.getByTestId('doc-block-turn-h2').click();
  await expect(ed.locator('h2', { hasText: 'בלוק אחד' })).toBeVisible();

  await ed.locator('h2', { hasText: 'בלוק אחד' }).hover();
  await page.getByTestId('doc-drag-handle').click();
  await page.getByTestId('doc-block-duplicate').click();
  await expect(ed.locator('h2', { hasText: 'בלוק אחד' })).toHaveCount(2);

  await ed.locator('p', { hasText: 'בלוק שני' }).hover();
  await page.getByTestId('doc-drag-handle').click();
  await page.getByTestId('doc-block-up').click();
  await expect(ed.locator(':scope > *').nth(1)).toContainText('בלוק שני');

  await ed.locator('p', { hasText: 'בלוק שני' }).hover();
  await page.getByTestId('doc-drag-handle').click();
  await page.getByTestId('doc-block-delete').click();
  await expect(ed.locator('p', { hasText: 'בלוק שני' })).toHaveCount(0);
  await ready(page);
});

test('a right click in a doc opened from a board shows the doc’s menu, not the board’s', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const itemName = `לחיצה ימנית ${uid()}`;
  const { boardId } = await newBoard(page, { title: 'אפיון', type: 'doc' }, itemName);
  await page.goto(`/a/demo/b/${boardId}`);
  const row = page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`);
  await row.getByTestId('doc-cell-new').click();
  const panel = page.getByTestId('doc-panel');
  await ready(panel);
  await panel.locator('.ProseMirror').click();
  await page.keyboard.type('טקסט במסמך');
  await page.keyboard.press('Shift+Home');

  await panel.locator('.ProseMirror p', { hasText: 'טקסט במסמך' }).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toHaveCount(1);
  await expect(menu.getByTestId('doc-ctx-copy')).toBeVisible();
  await expect(menu.getByTestId('doc-block-delete')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(panel).toBeVisible();

  // The same on a doc page.
  await panel.getByTestId('doc-panel-page').click();
  await ready(page);
  await editor(page).locator('p', { hasText: 'טקסט במסמך' }).click({ button: 'right' });
  await expect(page.getByRole('menu').getByTestId('doc-ctx-paste')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('its author ticks a check box in a rendered update; it is saved', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers, boardId, itemId } = await newBoard(page, { title: 'סטטוס', type: 'status' }, `משימות ${uid()}`);
  const task = (text: string) => ({
    type: 'taskItem',
    attrs: { checked: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  await page.request.post(`/api/v1/items/${itemId}/updates`, {
    headers,
    data: { doc: { type: 'doc', content: [{ type: 'taskList', content: [task('לבדוק חוזה'), task('לשלוח')] }] } },
  });
  await page.goto(`/a/demo/b/${boardId}/i/${itemId}`);
  const body = page.locator('.update-body').first();
  const boxes = body.getByTestId('update-task-box');
  await expect(boxes).toHaveCount(2);
  // On the text's line. Measured together, once the card has settled (the composer above it grows as it loads, so
  // two boxes read a moment apart can be from different layouts).
  await expect
    .poll(async () => {
      const [b, p] = await Promise.all([boxes.first().boundingBox(), body.locator('li p').first().boundingBox()]);
      return b && p ? Math.abs(b.y + b.height / 2 - (p.y + p.height / 2)) : Infinity;
    })
    .toBeLessThan(6);

  await boxes.nth(1).click();
  await expect(body.locator('li[data-checked="true"]')).toHaveCount(1);
  // a tick is saved as that one box — the update is not marked edited.
  await page.reload();
  await expect(page.getByTestId('update-entry').first()).not.toContainText('נערך');
  await expect(page.locator('.update-body').first().locator('li[data-checked="true"]')).toContainText('לשלוח');
});

test('a file cell offers "new doc": the doc opens in the side panel and stays in the cell', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const itemName = `קבצים ${uid()}`;
  const { boardId } = await newBoard(page, { title: 'קבצים', type: 'file' }, itemName);
  await page.goto(`/a/demo/b/${boardId}`);
  const row = page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`);
  await row.getByTestId('file-cell').click();
  await expect(page.getByTestId('file-cell-upload')).toBeVisible();
  await page.getByTestId('file-cell-new-doc').click();
  const panel = page.getByTestId('doc-panel');
  await ready(panel);
  await expect(panel.getByTestId('doc-title')).toHaveText(itemName);
  await panel.locator('.ProseMirror').click();
  await page.keyboard.type('הצעת מחיר');
  await ready(panel);
  // Round 13: the first Esc leaves the editor, the second closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel.locator('.ProseMirror')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  await expect(row.getByTestId('file-cell-doc')).toContainText(itemName);
  await row.getByTestId('file-cell-doc').click();
  await expect(page.getByTestId('doc-panel').locator('.ProseMirror')).toContainText('הצעת מחיר');
  await page.getByTestId('doc-panel-close').click();
});
