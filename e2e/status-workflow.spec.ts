// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * a status column's workflow: the owner opens it from the column's menu, ticks the allowed moves in the
 * grid and makes a field required for one move; the picker then fades what the current label may not reach, a blocked
 * label asks the owner before passing the workflow, and a move with an empty required field opens a popup that asks for it.
 */
const LABELS = [
  { id: 0, label: 'חדש', color: 'yellow', index: 0 },
  { id: 1, label: 'בטיפול', color: 'navy', index: 1 },
  { id: 2, label: 'סגור', color: 'forest', index: 2, is_done: true },
];

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'put', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string }>('post', '/boards', { name: `workflow ${tag}`, workspace_id: ws.id });
  const stage = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שלב',
    type: 'status',
    settings: { labels: LABELS },
  });
  const note = await api<{ id: string }>('post', `/boards/${board.id}/columns`, { title: 'הערה', type: 'text' });
  const name = `פנייה ${tag}`;
  await api('post', `/boards/${board.id}/items`, { name, cells: { [stage.id]: { index: 0 } } });
  return { boardId: board.id, stage: stage.id, note: note.id, name };
};

test('the owner sets the allowed moves; the picker fades the rest, asks before passing, names a missing field', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId, stage, note, name } = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${boardId}`);

  // The column's menu → the workflow editor.
  await page.locator(`[data-header="${stage}"]`).click({ button: 'right' });
  await page.getByRole('menu').getByTestId('column-workflow').click();
  const dialog = page.getByTestId('workflow-dialog');
  await expect(dialog).toBeVisible();
  // חדש → בטיפול, בטיפול → סגור (the field "הערה" required).
  await dialog.getByTestId('workflow-cell-0-1').click();
  await dialog.getByTestId('workflow-cell-1-2').click();
  await expect(dialog.getByTestId('workflow-cell-0-1')).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByTestId('workflow-cell-0-2')).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByTestId('workflow-rules')).toBeVisible(); // the move just ticked is open
  await dialog.getByTestId(`workflow-required-${note}`).click();
  await expect(dialog.getByTestId(`workflow-required-${note}`)).toHaveAttribute('aria-pressed', 'true');
  // Who: a search adds a person as a chip, × takes them off again (nobody = everyone who may edit).
  // The search narrows to the first member's name (whoever the account has), then picks them.
  const firstWho = dialog.locator('[data-testid^="workflow-who-"][aria-pressed="false"]').first();
  await dialog.getByTestId('workflow-who-search').fill((await firstWho.textContent())!.trim());
  await firstWho.click();
  await expect(dialog.getByTestId('workflow-who-chosen').getByRole('button')).toHaveCount(1);
  await dialog.getByTestId('workflow-who-chosen').getByRole('button').click();
  await expect(dialog.getByTestId('workflow-who-chosen')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('workflow-dialog.png') });
  await page.getByTestId('workflow-save').click();
  await expect(dialog).toBeHidden();

  // The picker from חדש: בטיפול open, סגור faded.
  const cell = row(page, name).locator(`[data-column="${stage}"] [data-cell-edit]`);
  const popover = page.getByTestId('popover');
  await cell.click();
  const option = (label: string) => popover.getByTestId('status-option').filter({ hasText: label });
  await expect(option('סגור')).toHaveAttribute('data-blocked', 'true');
  await expect(option('בטיפול')).not.toHaveAttribute('data-blocked', 'true');
  await page.screenshot({ path: test.info().outputPath('workflow-picker.png') });
  // The owner may pass the block: the app's own dialog asks first (cancel keeps the label).
  await option('סגור').click();
  await expect(page.getByText('לבצע מעבר שה-workflow חוסם?')).toBeVisible();
  await page.getByRole('button', { name: 'ביטול', exact: true }).click();
  await expect(page.getByText('לבצע מעבר שה-workflow חוסם?')).toBeHidden();
  await expect(cell).toHaveText('חדש');

  // An allowed move.
  await cell.click();
  await option('בטיפול').click();
  await expect(cell).toHaveText('בטיפול');
  // בטיפול → סגור needs "הערה" and it is empty: a popup asks for it (the label stays until it is saved).
  await cell.click();
  await option('סגור').click();
  const popup = page.getByTestId('popup-dialog');
  await expect(popup).toBeVisible();
  await expect(cell).toHaveText('בטיפול');
  await popup.locator(`[data-column="${note}"]`).click();
  await page.keyboard.type('נסגר');
  await page.keyboard.press('Enter');
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
  await expect(cell).toHaveText('סגור');
  await expect(row(page, name).locator(`[data-column="${note}"]`)).toHaveText('נסגר');
});

test('phase 2: a move and a button open a popup; its values and note are saved with the action', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const { boardId, stage, note, name } = await setup(page);
  const req = (method: 'patch' | 'post', path: string, data: unknown) =>
    page.request[method](`/api/v1${path}`, { headers, data });
  const workflow = {
    enabled: true,
    transitions: [
      { from: 0, to: 1, popup: { fields: [{ column_id: note, required: true }], note: 'optional' } },
      { from: 1, to: 2 },
    ],
  };
  expect(
    (await req('patch', `/boards/${boardId}/columns/${stage}`, { settings: { labels: LABELS, workflow } })).status(),
  ).toBe(200);
  const button = await (
    await req('post', `/boards/${boardId}/columns`, {
      title: 'סגירה',
      type: 'button',
      settings: { action: { kind: 'popup', popup: { title: 'סיכום', fields: [], note: 'required' } } },
    })
  ).json();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${boardId}`);

  // The move חדש → בטיפול opens the popup; "save" without the required field says which one.
  const cell = row(page, name).locator(`[data-column="${stage}"] [data-cell-edit]`);
  await cell.click();
  await page.getByTestId('popover').getByTestId('status-option').filter({ hasText: 'בטיפול' }).click();
  const popup = page.getByTestId('popup-dialog');
  await expect(popup).toBeVisible();
  await page.getByTestId('popup-save').click();
  await expect(page.getByTestId('popup-error')).toHaveText('צריך למלא: הערה');
  await expect(cell).toHaveText('חדש');
  // Fill it (the board's own text editor) and a note; save → the label and the value together.
  await popup.locator(`[data-column="${note}"]`).click();
  await page.keyboard.type('מחכים ללקוח');
  await page.keyboard.press('Enter');
  await page.getByTestId('popup-note').fill('הערה מהחלונית');
  await page.screenshot({ path: test.info().outputPath('popup-move.png') });
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
  await expect(cell).toHaveText('בטיפול');
  await expect(row(page, name).locator(`[data-column="${note}"]`)).toHaveText('מחכים ללקוח');

  // The button asks for a required note; cancel does nothing, save records the click with the note.
  await row(page, name).locator(`[data-column="${button.id}"]`).getByTestId('button-cell').click();
  await expect(popup).toBeVisible();
  await expect(page.getByRole('heading', { name: 'סיכום' })).toBeVisible();
  await page.getByTestId('popup-save').click();
  await expect(page.getByTestId('popup-error')).toHaveText('צריך לכתוב הערה');
  await page.getByTestId('popup-note').fill('נסגר בטלפון');
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
});
