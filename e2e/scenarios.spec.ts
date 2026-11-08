// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * phase 3 — the scenario builder: the board's menu lists the scenarios; the editor shows the graph on the
 * canvas (blocks, settings of the chosen one), adds a block from the palette, switches the scenario on; a status change
 * runs it and the run log shows its steps.
 */
const LABELS = [
  { id: 0, label: 'חדש', color: 'yellow', index: 0 },
  { id: 1, label: 'בטיפול', color: 'navy', index: 1 },
];

const rule = (column_id: string, operator: string, values: unknown[] = []) => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id, operator, values, negate: false }],
});

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string }>('post', '/boards', { name: `תרחישים ${tag}`, workspace_id: ws.id });
  const stage = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שלב',
    type: 'status',
    settings: { labels: LABELS },
  });
  const note = await api<{ id: string }>('post', `/boards/${board.id}/columns`, { title: 'הערה', type: 'text' });
  const budget = await api<{ id: string }>('post', `/boards/${board.id}/columns`, { title: 'תקציב', type: 'numbers' });
  const graph = {
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        x: 600,
        y: 120,
        trigger: { type: 'status_changed', column: stage.id, labels: ['בטיפול'] },
      },
      {
        id: 'r',
        kind: 'router',
        x: 360,
        y: 100,
        mode: 'first',
        branches: [{ id: 'big', label: 'תקציב גבוה', conditions: rule(budget.id, 'greater_than', [1000]) }],
      },
      { id: 'a1', kind: 'action', x: 100, y: 20, action: { type: 'set_column', column: note.id, value: 'לקוח גדול' } },
      { id: 'a2', kind: 'action', x: 100, y: 220, action: { type: 'set_column', column: note.id, value: 'לקוח רגיל' } },
    ],
    edges: [
      { id: 'e1', from: 't', to: 'r' },
      { id: 'e2', from: 'r', to: 'a1', branch: 'big' },
      { id: 'e3', from: 'r', to: 'a2', branch: 'else' },
    ],
  };
  const scenario = await api<{ id: string }>('post', `/boards/${board.id}/scenarios`, {
    name: `קליטת ליד ${tag}`,
    graph,
  });
  const item = await api<{ id: string }>('post', `/boards/${board.id}/items`, {
    name: `ליד ${tag}`,
    cells: { [stage.id]: { index: 0 }, [budget.id]: 5000 },
  });
  return { boardId: board.id, stage: stage.id, note: note.id, tag, scenarioId: scenario.id, itemId: item.id, headers };
};

test('the builder: open from the board, see the graph, add a block, switch on, a change runs it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId, stage, note, tag, itemId, headers } = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${boardId}`);

  await page.getByTestId('board-more').click();
  await page.getByRole('menu').getByTestId('board-scenarios').click();
  const list = page.getByTestId('scenarios-dialog');
  await expect(list.getByTestId('scenario-row')).toHaveCount(1);
  await list.getByTestId('scenario-open').click();

  const editor = page.getByTestId('scenario-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('scenario-node')).toHaveCount(4);
  await expect(editor.getByTestId('scenario-overview')).toContainText('התרחיש תקין');
  await page.screenshot({ path: test.info().outputPath('scenario-editor.png') });

  // The router's settings: its branch and "otherwise".
  await editor.locator('[data-testid="scenario-node"][data-node-id="r"]').click();
  const settings = editor.getByTestId('scenario-node-settings');
  await expect(settings).toHaveAttribute('data-kind', 'router');
  await expect(settings.getByTestId('scenario-branch')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('scenario-router.png') });

  // A wait added after the chosen action (palette click), then removed again.
  await editor.locator('[data-testid="scenario-node"][data-node-id="a1"]').click();
  await editor.getByTestId('scenario-add-wait').click();
  await expect(editor.getByTestId('scenario-node')).toHaveCount(5);
  await expect(editor.getByTestId('scenario-node-settings')).toHaveAttribute('data-kind', 'wait');
  await editor.getByTestId('scenario-node-delete').click();
  await expect(editor.getByTestId('scenario-node')).toHaveCount(4);

  // Pointing at the line trigger → router shows its "+" and bin; "+" puts a block in the middle.
  const tools = editor.locator('[data-testid="scenario-edge-tools"][data-edge-id="e1"]');
  const box = (await tools.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(tools).toHaveCSS('opacity', '1');
  await tools.getByTestId('scenario-edge-insert').click();
  await page.getByTestId('scenario-add-menu').getByTestId('scenario-pick-wait').click();
  await expect(editor.getByTestId('scenario-node')).toHaveCount(5);
  await expect(editor.getByTestId('scenario-edge-tools')).toHaveCount(4);
  await page.mouse.move(10, 300);
  // The first half of the split line took its id; the pointer left, so its buttons hide again.
  await expect(tools).toHaveCSS('opacity', '0');
  await page.screenshot({ path: test.info().outputPath('scenario-inserted.png') });
  // The block's own bin removes it, and the line trigger → router comes back.
  const inserted = editor.locator('[data-testid="scenario-node"][data-kind="wait"]');
  await inserted.hover();
  await inserted.getByTestId('scenario-node-remove').click();
  await expect(editor.getByTestId('scenario-node')).toHaveCount(4);
  await expect(editor.getByTestId('scenario-edge-tools')).toHaveCount(3);
  await expect(editor.getByTestId('scenario-overview')).toContainText('התרחיש תקין');

  // Save, switch on; a status change runs it: the big-budget branch writes the note.
  await editor.getByTestId('scenario-save').click();
  await editor.getByTestId('scenario-active').click();
  await expect(editor.getByTestId('scenario-active')).toBeChecked();
  await page.request.put(`/api/v1/items/${itemId}/cells/${stage}`, { headers, data: { value: { index: 1 } } });
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/v1/items/${itemId}`, { headers })).json()) as {
            cells: Record<string, { value?: unknown }>;
          }
        ).cells[note]?.value,
      { timeout: 30_000 },
    )
    .toBe('לקוח גדול');

  await editor.getByTestId('scenario-runs').click();
  const runs = page.getByTestId('scenario-runs-dialog');
  await expect(runs.getByTestId('scenario-run').first()).toHaveAttribute('data-status', 'succeeded');
  await expect(runs.getByTestId('scenario-step')).toHaveCount(2);
  await expect(runs).toContainText('תקציב גבוה');
  // The dialog's fade has settled before the picture.
  await page.waitForTimeout(600);
  await page.screenshot({ path: test.info().outputPath('scenario-runs.png') });
  void tag;
});
