// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * AI style examples (round 3): the "Style examples" section of the AI column's settings and of the
 * automation builder's generate_image photo slot — a files column, the board filter editor (its nested pickers open
 * and close with the app's own menus, never a native <select> or dialog), the count; saved and read back. In the
 * builder the slot's popover stays open while the filter is edited, and the sentence names the style column.
 * Data through the API; no AI call is made.
 */
const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

const STYLE = 'סקיצה מאושרת';
const STAGE = 'שלב';
const APPROVED = 'מאושר';

const setup = async (page: Page, headers: Headers, tag: string) => {
  const post = async <T = { id: string }>(path: string, data: unknown) =>
    (await (await page.request.post(api(path), { headers, data })).json()) as T;
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = await post('/ai/connections', {
    name: `E2E style ${tag}`,
    provider: 'anthropic',
    api_key: 'sk-ant-e2e-scripted-0000',
  });
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = await post('/boards', { name: `AI style ${tag}`, workspace_id: ws });
  const photos = await post(`/boards/${board.id}/columns`, { title: 'תמונות', type: 'file' });
  const sketches = await post(`/boards/${board.id}/columns`, { title: 'סקיצות', type: 'file' });
  const style = await post(`/boards/${board.id}/columns`, { title: STYLE, type: 'file' });
  await post(`/boards/${board.id}/columns`, {
    title: STAGE,
    type: 'status',
    settings: {
      labels: [
        { id: 0, label: APPROVED, color: 'green', index: 0 },
        { id: 1, label: 'טיוטה', color: 'yellow', index: 1 },
      ],
    },
  });
  await post(`/boards/${board.id}/items`, { name: `פריט ${tag}` });
  const cleanup = async () => {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  };
  return { post, connection, board, photos, sketches, style, cleanup };
};

/** No native picker anywhere: no <select> on the page (dialogs throw through forbidNativeDialogs). */
const noNativePickers = async (page: Page) => expect(page.locator('select')).toHaveCount(0);

/** Opens an app menu from its trigger, picks an entry by name, and checks the menu closed again. */
const pick = async (page: Page, trigger: Locator, name: string) => {
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await noNativePickers(page);
  await menu.getByRole('menuitemradio', { name, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
};

/**
 * In a style section: add a status rule and pick the "approved" label. Each nested picker opens and closes; the
 * label list (several choices) closes with Escape — only it, not what holds it.
 */
const addApprovedRule = async (page: Page, section: Locator) => {
  const editor = section.getByTestId('ai-style-filter');
  await editor.getByTestId('filter-add-rule').click();
  const rule = editor.getByTestId('filter-rule').last();
  await pick(page, rule.getByTestId('rule-column'), STAGE);
  await expect(rule.getByTestId('rule-column')).toContainText(STAGE);
  await rule.getByTestId('rule-values').click();
  const label = page.getByRole('checkbox', { name: APPROVED, exact: true });
  await expect(label).toBeVisible();
  await noNativePickers(page);
  await label.click();
  await expect(label).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(label).toHaveCount(0);
  await expect(rule.getByTestId('rule-values')).toContainText(APPROVED);
};

test('AI column: style examples — files column, the board filter, the count; kept after saving', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { post, connection, board, sketches, cleanup } = await setup(page, headers, tag);
  try {
    const col = await post(`/boards/${board.id}/columns`, {
      title: 'עיצוב AI',
      type: 'ai',
      settings: { output: 'image', connection_id: connection.id, image_column: sketches.id },
    });
    const openSettings = async () => {
      await page.locator(`[data-header="${col.id}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
      await expect(page.getByTestId('ai-column-form')).toBeVisible();
      return page.getByTestId('ai-style');
    };
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(page.locator(`[data-header="${col.id}"]`)).toBeVisible();

    let section = await openSettings();
    // Off by default: only the switch and the hint.
    await expect(section.getByTestId('ai-style-on')).not.toBeChecked();
    await expect(section.getByTestId('ai-style-column')).toHaveCount(0);
    await section.getByTestId('ai-style-on').click();
    await expect(section.getByTestId('ai-style-on')).toBeChecked();
    await expect(section.getByTestId('ai-style-cost')).toBeVisible();

    await pick(page, section.getByTestId('ai-style-column'), STYLE);
    await expect(section.getByTestId('ai-style-column')).toContainText(STYLE);
    await addApprovedRule(page, section);
    // The settings dialog is still open after the nested pickers closed.
    await expect(page.getByTestId('ai-column-form')).toBeVisible();

    await section.getByTestId('ai-style-count').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByTestId('ai-style-count-2').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(section.getByTestId('ai-style-count')).toContainText('2');
    await noNativePickers(page);

    await page.getByTestId('column-settings-save').click();
    await expect(page.getByTestId('ai-column-form')).toHaveCount(0);

    // Saved on the column …
    const saved = (await (await page.request.get(api(`/boards/${board.id}`), { headers })).json()) as {
      columns: { id: string; settings: Record<string, unknown> }[];
    };
    const settings = saved.columns.find((c) => c.id === col.id)!.settings as {
      style_examples: { column: string; count: number; filter: { rules: { column_id: string }[] } } | null;
    };
    expect(settings.style_examples).toMatchObject({ count: 2 });
    expect(settings.style_examples!.filter.rules).toHaveLength(1);

    // … and read back by the form.
    section = await openSettings();
    await expect(section.getByTestId('ai-style-on')).toBeChecked();
    await expect(section.getByTestId('ai-style-column')).toContainText(STYLE);
    await expect(section.getByTestId('ai-style-count')).toContainText('2');
    const rule = section.getByTestId('ai-style-filter').getByTestId('filter-rule');
    await expect(rule).toHaveCount(1);
    await expect(rule.getByTestId('rule-column')).toContainText(STAGE);
    await expect(rule.getByTestId('rule-values')).toContainText(APPROVED);
    await page.keyboard.press('Escape');
  } finally {
    await cleanup();
  }
});

test('builder: generate_image style examples — the popover stays open while the filter is edited', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { post, board, photos, sketches, cleanup } = await setup(page, headers, tag);
  try {
    const title = `סגנון ${tag}`;
    await post(`/boards/${board.id}/automations`, {
      title,
      is_active: false,
      recipe: {
        trigger: { type: 'file_added', column: photos.id },
        actions: [{ type: 'generate_image', column: sketches.id, source_columns: [photos.id], prompt: '{item.name}' }],
      },
    });
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-automations').click();
    const row = page.locator('[data-testid="automation-row"]', { hasText: title });
    await expect(row).toBeVisible();
    await row.getByTestId('automation-edit').click();
    const builder = page.getByTestId('automation-builder');
    await expect(builder).toBeVisible();

    const slot = builder.locator('[data-slot="actions.0.source_columns"]');
    await slot.click();
    const popover = page.getByTestId('slot-source-columns');
    await expect(popover).toBeVisible();
    const section = popover.getByTestId('ai-style');
    await section.getByTestId('ai-style-on').click();
    await expect(section.getByTestId('ai-style-on')).toBeChecked();
    await expect(popover).toBeVisible();

    await pick(page, section.getByTestId('ai-style-column'), STYLE);
    await expect(popover).toBeVisible();
    await addApprovedRule(page, section);
    await expect(popover).toBeVisible();
    await section.getByTestId('ai-style-count').click();
    await page.getByTestId('ai-style-count-2').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(popover).toBeVisible();
    await noNativePickers(page);

    // Close the slot: the sentence names the style column.
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(slot).toContainText(STYLE);

    await page.getByTestId('auto-save-inactive').click();
    await expect(row).toBeVisible();
    const list = (await (await page.request.get(api(`/boards/${board.id}/automations`), { headers })).json()) as {
      data: { title: string; recipe: { actions: Record<string, unknown>[] } }[];
    };
    const action = list.data.find((a) => a.title === title)!.recipe.actions[0] as {
      style_examples?: { count: number; filter: { rules: unknown[] } | null };
    };
    expect(action.style_examples).toMatchObject({ count: 2 });
    expect(action.style_examples!.filter!.rules).toHaveLength(1);

    // Reopened: the sentence still names it.
    await row.getByTestId('automation-edit').click();
    await expect(builder.locator('[data-slot="actions.0.source_columns"]')).toContainText(STYLE);
  } finally {
    await cleanup();
  }
});
