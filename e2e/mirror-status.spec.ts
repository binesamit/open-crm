// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 15 — columns (prod fixes):
 * 1. A mirror of a status column shows as text, coloured chips or the footer's colour bar (column settings).
 * 2. Progress: a clear source (subitems / status columns / both), the done labels, sub-subitems, a weight column,
 *    an empty state that says what is missing and a live example — and the server computes it.
 * 3. Formula: "{" opens the columns (and functions) at the caret; typing filters, arrows move, Enter inserts, Esc
 * closes. Columns show by name and are stored by id.
 */
const api = (path: string) => `/api/v1${path}`;
const tag = () => Date.now().toString(36);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
type Ctx = Awaited<ReturnType<typeof ownerContext>>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const post = async (page: Page, headers: Ctx['headers'], path: string, data: unknown) =>
  (await (await page.request.post(api(path), { headers, data })).json()) as Json;
const put = (page: Page, headers: Ctx['headers'], path: string, data: unknown) =>
  page.request.put(api(path), { headers, data });
const newBoard = async (page: Page, headers: Ctx['headers'], name: string) => {
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  return post(page, headers, '/boards', { name, workspace_id: ws });
};
const columnSettings = async (page: Page, title: string) => {
  await page.getByRole('button', { name: new RegExp(`^פעולות לעמודה ${title}`) }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'הגדרות עמודה' }).click();
};

/** A board with an item, three subitems on a status column (one sub-subitem), and the item's own status. */
const setUp = async (page: Page, headers: Ctx['headers'], name: string) => {
  const board = await newBoard(page, headers, name);
  const item = await post(page, headers, `/boards/${board.id}/items`, { name: 'Parent' });
  const subs: Json[] = [];
  for (const n of ['S1', 'S2', 'S3']) subs.push(await post(page, headers, `/items/${item.id}/subitems`, { name: n }));
  const subBoard = subs[0]!.board_id as string;
  // The sub-board's default status column goes: "Phase" is its only status column.
  const subCols = ((await (await page.request.get(api(`/boards/${subBoard}`), { headers })).json()) as Json)
    .columns as Json[];
  for (const c of subCols.filter((x) => x.type === 'status'))
    await page.request.delete(api(`/boards/${subBoard}/columns/${c.id}`), { headers });
  const st = await post(page, headers, `/boards/${subBoard}/columns`, { title: 'Phase', type: 'status' });
  const labels = st.settings.labels as Json[];
  const done = labels.find((l) => l.is_done)!;
  const working = labels.find((l) => !l.is_done)!;
  await put(page, headers, `/items/${subs[0]!.id}/cells/${st.id}`, { value: { index: done.id } });
  await put(page, headers, `/items/${subs[1]!.id}/cells/${st.id}`, { value: { index: working.id } });
  await put(page, headers, `/items/${subs[2]!.id}/cells/${st.id}`, { value: { index: working.id } });
  // S3 has two sub-subitems, both done.
  for (const n of ['S3a', 'S3b']) {
    const x = await post(page, headers, `/items/${subs[2]!.id}/subitems`, { name: n });
    await put(page, headers, `/items/${x.id}/cells/${st.id}`, { value: { index: done.id } });
  }
  return { board, item, subBoard, st, done, working };
};

test('mirror of a status column: text, coloured chips or the colour bar', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const { board, st, done, working } = await setUp(page, headers, `Mirror ${tag()}`);
  await post(page, headers, `/boards/${board.id}/columns`, {
    title: 'Phases',
    type: 'mirror',
    settings: { relation_column_id: '__subitems__', source_column_id: st.id },
  });
  await page.goto(`/a/demo/b/${board.id}`);
  const cell = row(page, 'Parent').locator('[data-column-type="mirror"]');
  await expect(cell).toContainText(done.label);

  await columnSettings(page, 'Phases');
  const display = page.getByTestId('mirror-display');
  await expect(display).toBeVisible();
  await display.getByTestId('mirror-display-chips').click();
  await expect(page.getByTestId('mirror-preview').getByTestId('mirror-chip')).not.toHaveCount(0);
  await page.getByTestId('column-settings-save').click();
  const chips = cell.getByTestId('mirror-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: working.label })).toContainText('×2');

  await columnSettings(page, 'Phases');
  await page.getByTestId('mirror-display').getByTestId('mirror-display-bar').click();
  await page.getByTestId('column-settings-save').click();
  const segments = cell.getByTestId('mirror-bar-segment');
  await expect(segments).toHaveCount(2);
  await expect(segments.first()).toHaveAttribute('title', new RegExp(done.label));
});

test('progress: choose the source, the done labels, sub-subitems — with an empty state and a preview', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const { board, done, working } = await setUp(page, headers, `Progress ${tag()}`);
  // A new progress column is not set up: its cell says so.
  await post(page, headers, `/boards/${board.id}/columns`, { title: 'Done %', type: 'progress' });
  await page.goto(`/a/demo/b/${board.id}`);
  const cell = row(page, 'Parent').locator('[data-column-type="progress"]');
  await expect(cell.getByTestId('progress-unset')).toBeVisible();

  await columnSettings(page, 'Done %');
  // Subitems is preselected; its status column is the only one, its "done" label already on.
  await expect(page.getByTestId('progress-subitems-section')).toBeVisible();
  const doneChips = page.getByTestId('progress-sub-done');
  await expect(doneChips.locator(`[data-label="${done.label}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('progress-explain')).toContainText(done.label);
  // Turning every label off: the empty state lists what is missing, saving is off.
  await doneChips.locator(`[data-label="${done.label}"]`).click();
  await expect(page.getByTestId('progress-empty')).toBeVisible();
  await expect(page.getByTestId('column-settings-save')).toBeDisabled();
  await doneChips.locator(`[data-label="${done.label}"]`).click();
  await expect(page.getByTestId('progress-preview')).toBeVisible();
  await page.getByTestId('column-settings-save').click();
  // 1 of 3 subitems done → 33%.
  await expect(cell.getByTestId('progress-cell')).toHaveAttribute('data-percent', '33');

  // Sub-subitems: S3 counts by its two done sub-subitems → (1 + 0 + 1) / 3 → 67%.
  await columnSettings(page, 'Done %');
  await page.getByTestId('progress-recursive').click();
  await page.getByTestId('column-settings-save').click();
  await expect(cell.getByTestId('progress-cell')).toHaveAttribute('data-percent', '67');

  // "Working" counts as done too → every subitem → 100%.
  await columnSettings(page, 'Done %');
  await page.getByTestId('progress-sub-done').locator(`[data-label="${working.label}"]`).click();
  await page.getByTestId('column-settings-save').click();
  await expect(cell.getByTestId('progress-cell')).toHaveAttribute('data-percent', '100');

  // Status columns of the item: none ticked yet → the empty state says so.
  await columnSettings(page, 'Done %');
  await page.getByTestId('progress-source-columns').click();
  await expect(page.getByTestId('progress-empty')).toBeVisible();
  await expect(page.getByTestId('column-settings-save')).toBeDisabled();
});

test('formula: "{" opens the columns at the caret, typing filters, Enter inserts, Esc closes', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const board = await newBoard(page, headers, `Formula ${tag()}`);
  const item = await post(page, headers, `/boards/${board.id}/items`, { name: 'Row' });
  const price = await post(page, headers, `/boards/${board.id}/columns`, { title: 'Price', type: 'numbers' });
  await post(page, headers, `/boards/${board.id}/columns`, { title: 'Quantity', type: 'numbers' });
  await put(page, headers, `/items/${item.id}/cells/${price.id}`, { value: 21 });
  await post(page, headers, `/boards/${board.id}/columns`, { title: 'Calc', type: 'formula' });
  await page.goto(`/a/demo/b/${board.id}`);

  await columnSettings(page, 'Calc');
  const input = page.getByTestId('formula-input');
  await input.click();
  await page.keyboard.type('{');
  const list = page.getByTestId('formula-suggest');
  await expect(list).toBeVisible();
  await expect(list.locator('[data-kind="column"][data-key]')).not.toHaveCount(0);
  // Live filter.
  await page.keyboard.type('pri');
  await expect(list.locator('[data-kind="column"]')).toHaveCount(1);
  await expect(list.locator('[data-kind="column"]').first()).toContainText('Price');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  // the editor shows the column's name; it is stored by id.
  await expect(input).toHaveValue('{Price}');
  await expect(input).toBeFocused();

  // Arrows move; Esc closes the list but not the dialog.
  await page.keyboard.type(' * {');
  await expect(list).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(list.getByTestId('formula-suggest-option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Re-open by typing on: a click on an option inserts it.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('{');
  await expect(list).toBeVisible();
  await page.keyboard.type('zzq');
  await expect(list.getByTestId('formula-suggest-empty')).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('pri');
  await list.locator('[data-kind="column"]', { hasText: 'Price' }).click();
  await expect(list).toBeHidden();
  await expect(input).toHaveValue('{Price} * {Price}');
  await page.getByTestId('column-settings-save').click();
  await expect(row(page, 'Row').locator('[data-column-type="formula"]')).toHaveText('441');
  const stored = async () =>
    (((await (await page.request.get(api(`/boards/${board.id}`), { headers })).json()) as Json).columns as Json[]).find(
      (c) => c.title === 'Calc' || c.type === 'formula',
    )!.settings.formula;
  expect(await stored()).toBe(`{${price.id}} * {${price.id}}`);
  // A rename: the formula keeps working and the editor shows the new name.
  await page.request.patch(api(`/boards/${board.id}/columns/${price.id}`), { headers, data: { title: 'Cost' } });
  await page.reload();
  await columnSettings(page, 'Calc');
  await expect(input).toHaveValue('{Cost} * {Cost}');
  await expect(row(page, 'Row').locator('[data-column-type="formula"]')).toHaveText('441');
});
