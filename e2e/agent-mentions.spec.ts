// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Agents stages מ8 (triggers) and מ9 (knowledge) — the planning notes "AGENTS-MCP", D26:
 *  1. "When the agent acts": switch on "on a mention" in the editor, mention the agent ("digital worker") in an
 *     item's update → it runs and answers in the thread; its write shows on the item.
 *  2. An automation's `run_agent` starts it; the agent's "when it acts" tab lists that automation.
 *  3. Knowledge: a note and an uploaded TXT file are indexed (status "ready"); a source is removed.
 *
 * Needs the API started with `AI_FAKE=scripted` (playwright.config sets it): the scripted model plays the
 * `TOOL <name> <json>` lines of the run's first message — here they come from the trigger's task text (the
 * trusted part: an item's values and a mention's text arrive wrapped as untrusted data, AI-RT4).
 */
const api = (path: string) => `/api/v1${path}`;

type Setup = {
  headers: Record<string, string>;
  tag: string;
  connectionId: string;
  boardId: string;
  itemId: string;
  agentId: string;
  agentName: string;
  restore: () => Promise<void>;
};

const setup = async (page: Page): Promise<Setup> => {
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as { enabled: boolean };
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E agents2 ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Agents2 e2e ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Lead ${tag}` } })
  ).json()) as { id: string };
  const agentName = `עוזר ${tag}`;
  const agent = (await (
    await page.request.post(api('/agents'), {
      headers,
      data: {
        name: agentName,
        connection_id: connection.id,
        model: 'claude-opus-5-5',
        tools: ['get_item', 'update_item'],
        boards: [{ board_id: board.id, level: 'edit' }],
        approval_mode: 'autonomous',
      },
    })
  ).json()) as { id: string };
  return {
    headers,
    tag,
    connectionId: connection.id,
    boardId: board.id,
    itemId: item.id,
    agentId: agent.id,
    agentName,
    restore: async () => {
      await page.request.delete(api(`/agents/${agent.id}`), { headers });
      await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
      await page.request.delete(api(`/boards/${board.id}`), { headers });
      await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
    },
  };
};

test('a mention of the agent in an update starts it; it answers in the thread', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const s = await setup(page);
  const itemName = async () =>
    ((await (await page.request.get(api(`/items/${s.itemId}`), { headers: s.headers })).json()) as { name: string })
      .name;
  try {
    // 1. "When the agent acts": on a mention, with a task (the scripted model plays its TOOL line).
    await page.goto(`/a/demo/agents/${s.agentId}`);
    await page.getByTestId('agent-tab-triggers').click();
    // sec2: a new agent may already act on a mention (the account's default) — make sure it is on.
    await page.getByTestId('agent-trigger-mention').check();
    await page
      .getByTestId('agent-trigger-mention-task')
      .fill(`ענה לפונה.\nTOOL update_item {"item_id":"${s.itemId}","name":"Handled by agent ${s.tag}"}`);
    await expect(page.getByTestId('agent-trigger-boards')).toBeVisible();
    await page.getByTestId('agent-save').click();
    await expect(page.getByTestId('agent-save')).toBeDisabled();

    // 2. Mention it in the item's update: it is in the @ list as a digital worker.
    await page.goto(`/a/demo/b/${s.boardId}/i/${s.itemId}`);
    const card = page.getByRole('dialog', { name: `Lead ${s.tag}` });
    await expect(card).toBeVisible();
    const editor = card.getByTestId('rich-editor').first().locator('[contenteditable="true"]');
    await editor.click();
    await page.keyboard.type(`@${s.agentName.slice(0, 4)}`);
    const option = page.getByRole('listbox').getByRole('option', { name: new RegExp(s.agentName) });
    await expect(option).toBeVisible();
    await expect(option.getByTestId('mention-agent')).toBeVisible();
    await option.click();
    await page.keyboard.type('מה המצב?');
    await card.getByTestId('composer-send').first().click();

    // 3. It ran: the item changed and its answer is a reply to the update.
    await expect.poll(itemName, { timeout: 30_000 }).toBe(`Handled by agent ${s.tag}`);
    await expect
      .poll(
        async () => {
          const updates = (await (
            await page.request.get(api(`/items/${s.itemId}/updates`), { headers: s.headers })
          ).json()) as { data: { replies: { body_text: string }[] }[] };
          return updates.data[0]?.replies.map((r) => r.body_text).join(' ') ?? '';
        },
        { timeout: 30_000 },
      )
      .toContain('Done (1 actions)');
    const runs = (await (
      await page.request.get(api(`/agents/runs?agent_id=${s.agentId}`), { headers: s.headers })
    ).json()) as { data: { trigger: string; status: string }[] };
    expect(runs.data[0]).toMatchObject({ trigger: 'mention', status: 'succeeded' });

    // The agent's runs tab shows it.
    await page.goto(`/a/demo/agents/${s.agentId}`);
    await page.getByTestId('agent-tab-runs').click();
    await expect(page.getByTestId('run-row').first()).toHaveAttribute('data-status', 'succeeded');
  } finally {
    await s.restore();
  }
});

test('an automation runs the agent; its "when it acts" tab lists the automation', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const s = await setup(page);
  try {
    const automation = (await (
      await page.request.post(api(`/boards/${s.boardId}/automations`), {
        headers: s.headers,
        data: {
          title: `Run agent ${s.tag}`,
          recipe: {
            trigger: { type: 'item_created' },
            actions: [{ type: 'run_agent', agent: s.agentId, prompt: 'סווג את {item.name}' }],
          },
          is_active: true,
        },
      })
    ).json()) as { id: string };
    await page.request.post(api(`/boards/${s.boardId}/items`), { headers: s.headers, data: { name: 'New one' } });
    // The task is the automation's text as written; the item's values it pulls in come along as data (AI-RT4).
    type Run = { id: string; trigger: string; prompt: string };
    let run: Run | undefined;
    await expect
      .poll(
        async () => {
          run = (
            (await (
              await page.request.get(api(`/agents/runs?agent_id=${s.agentId}`), { headers: s.headers })
            ).json()) as { data: Run[] }
          ).data.find((r) => r.trigger === 'automation');
          return run?.prompt.split('\n')[0] ?? '';
        },
        { timeout: 30_000 },
      )
      .toBe('סווג את {item.name}');
    const detail = (await (await page.request.get(api(`/agents/runs/${run!.id}`), { headers: s.headers })).json()) as {
      steps: { kind: string; text: string | null }[];
    };
    const first = detail.steps.find((x) => x.kind === 'prompt')?.text ?? '';
    expect(first).toMatch(/<untrusted_content source="automation">\s*סווג את New one\s*<\/untrusted_content>/);

    await page.goto(`/a/demo/agents/${s.agentId}`);
    await page.getByTestId('agent-tab-triggers').click();
    await expect(page.getByTestId('agent-automations')).toContainText(`Run agent ${s.tag}`);
    await page.screenshot({ path: 'e2e/screens/agents2-triggers.png' });
    await page.request.delete(api(`/automations/${automation.id}`), { headers: s.headers });
  } finally {
    await s.restore();
  }
});

test('knowledge: a note and a TXT file are indexed; a source is removed', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const s = await setup(page);
  try {
    await page.goto(`/a/demo/agents/${s.agentId}`);
    await page.getByTestId('agent-tab-knowledge').click();
    await expect(page.getByTestId('agent-knowledge-empty')).toBeVisible();

    await page.getByTestId('agent-knowledge-add-note').click();
    await page.getByTestId('agent-note-title').fill('שעות פעילות');
    await page.getByTestId('agent-note-text').fill('המשרד פתוח בימים א-ה 9:00-17:00.');
    await page.getByTestId('agent-note-save').click();

    await page
      .getByTestId('agent-knowledge-file-input')
      .setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('החזר כספי תוך 30 יום.') });

    const sources = page.getByTestId('agent-knowledge-source');
    await expect(sources).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator('[data-testid="agent-knowledge-source"][data-status="ready"]')).toHaveCount(2, {
      timeout: 20_000,
    });
    await page.screenshot({ path: 'e2e/screens/agents2-knowledge.png' });

    // Remove the note (a system confirm, never the browser's).
    await sources.filter({ hasText: 'שעות פעילות' }).getByTestId('agent-knowledge-remove').click();
    await page.getByRole('alertdialog').getByRole('button').last().click();
    await expect(sources).toHaveCount(1);
    await expect(sources.first()).toHaveAttribute('data-kind', 'file');
  } finally {
    await s.restore();
  }
});
