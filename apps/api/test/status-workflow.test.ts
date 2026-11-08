// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { activityLog, automationRuns, automations } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * a status column's workflow: allowed moves, required columns and `who`, enforced on every write path
 * (item update, cell PUT, bulk); the board owner may pass a blocked move on purpose; only the owner or an admin
 * changes the workflow, every change is a version, and a version can be put back.
 */
let t: TestContext;
let admin: string; // the boards' owner
let bob: string; // member, an editor
let acmeId: string;
let adminId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

// Labels: 0 In progress, 1 Done, 2 Blocked (the defaults).
const WORKFLOW = {
  enabled: true,
  free_start: true,
  allow_clear: false,
  allow_override: true,
  transitions: [
    { from: 0, to: 2 },
    { from: 2, to: 0 },
    { from: 0, to: 1, required: ['note'] },
    { from: 2, to: 1, who: { users: ['01NOBODY000000000000000000'], teams: [] } },
  ],
};

const setup = async (name: string) => {
  const board = await body(await as(admin).post('/boards', { name, workspace_id: ws }));
  const stage = await body(
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'stage', title: 'Stage', type: 'status' }),
  );
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'note', title: 'Note', type: 'text' });
  const res = await as(admin).patch(`/boards/${board.id}/columns/stage`, {
    settings: { ...stage.settings, workflow: WORKFLOW },
  });
  expect(res.status).toBe(200);
  return { boardId: board.id as string, settings: stage.settings as Json };
};
const newItem = async (boardId: string, cells: Json = { stage: { index: 0 } }) =>
  (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Task', cells }))).id as string;
const stageOf = async (itemId: string) => (await body(await as(admin).get(`/items/${itemId}`))).cells.stage?.value;

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
});
afterAll(() => t.close());

describe('status workflow', () => {
  it('allows only the mapped moves, with their required columns', async () => {
    const { boardId } = await setup('WF 1');
    const id = await newItem(boardId);
    // Not mapped: In progress → nothing straight to a label without a move.
    const blocked = await as(bob).put(`/items/${id}/cells/stage`, { value: { index: 1 } });
    expect(blocked.status).toBe(409);
    const err = await body(blocked);
    expect(err.error?.code ?? err.code).toBe('workflow_blocked');
    expect(JSON.stringify(err)).toContain('"reason":"required"');
    expect(JSON.stringify(err)).toContain('Note');
    // The required column in the same edit: written first, then the move passes.
    expect((await as(bob).patch(`/items/${id}`, { cells: { stage: { index: 1 }, note: 'done it' } })).status).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 1 });
    // Done → anything: no move out of Done, and clearing is off.
    expect((await as(bob).put(`/items/${id}/cells/stage`, { value: { index: 0 } })).status).toBe(409);
    expect((await as(bob).put(`/items/${id}/cells/stage`, { value: null })).status).toBe(409);
  });

  it('`who` limits a move; the owner passes a block on purpose and it is logged; members cannot', async () => {
    const { boardId } = await setup('WF 2');
    const id = await newItem(boardId);
    expect((await as(bob).put(`/items/${id}/cells/stage`, { value: { index: 2 } })).status).toBe(200);
    const who = await as(bob).put(`/items/${id}/cells/stage`, { value: { index: 1 } });
    expect(who.status).toBe(409);
    expect(JSON.stringify(await body(who))).toContain('"reason":"who"');
    expect(
      (await as(bob).put(`/items/${id}/cells/stage`, { value: { index: 1 }, workflow_override: true })).status,
    ).toBe(409);
    expect(
      (await as(admin).put(`/items/${id}/cells/stage`, { value: { index: 1 }, workflow_override: true })).status,
    ).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 1 });
    const log = await body(await as(admin).get(`/items/${id}/activity`));
    expect(JSON.stringify(log)).toContain('workflow_override');
  });

  it('a new item takes any label (free start); bulk skips the items the workflow blocks', async () => {
    const { boardId } = await setup('WF 3');
    const a = await newItem(boardId, { stage: { index: 2 } });
    const b = await newItem(boardId);
    const res = await body(
      await as(bob).post(`/boards/${boardId}/items/bulk`, {
        item_ids: [a, b],
        action: { type: 'set_cell', column_id: 'stage', value: { index: 0 } },
      }),
    );
    // a: Blocked → In progress is mapped; b already is In progress (no move).
    expect(res.skipped).toBe(0);
    const done = await body(
      await as(bob).post(`/boards/${boardId}/items/bulk`, {
        item_ids: [a, b],
        action: { type: 'set_cell', column_id: 'stage', value: { index: 1 } },
      }),
    );
    expect(done.skipped).toBe(2); // the note is required
    expect(await stageOf(a)).toEqual({ index: 0 });
  });

  it('only the owner changes the workflow; labels saved without it keep it; versions restore', async () => {
    const { boardId, settings } = await setup('WF 4');
    const off = { ...WORKFLOW, enabled: false };
    const denied = await as(bob).patch(`/boards/${boardId}/columns/stage`, {
      settings: { ...settings, workflow: off },
    });
    expect(denied.status).toBe(403);
    // The label editor sends labels only: the workflow stays.
    const labels = [...(settings.labels as Json[]), { id: 3, label: 'Review', color: 'blue', index: 3 }];
    const saved = await body(
      await as(bob).patch(`/boards/${boardId}/columns/stage`, { settings: { ...settings, labels } }),
    );
    expect(saved.settings.workflow.enabled).toBe(true);
    expect(
      (await as(admin).patch(`/boards/${boardId}/columns/stage`, { settings: { labels, workflow: off } })).status,
    ).toBe(200);
    const versions = (await body(await as(admin).get(`/boards/${boardId}/columns/stage/workflow-versions`))).versions;
    expect(versions.map((v: Json) => v.version)).toEqual([2, 1]);
    expect((await as(bob).post(`/boards/${boardId}/columns/stage/workflow-versions/1/restore`, {})).status).toBe(403);
    const restored = await body(
      await as(admin).post(`/boards/${boardId}/columns/stage/workflow-versions/1/restore`, {}),
    );
    expect(restored.settings.workflow.enabled).toBe(true);
    expect(restored.settings.labels).toHaveLength(4);
    const after = (await body(await as(admin).get(`/boards/${boardId}/columns/stage/workflow-versions`))).versions;
    expect(after[0].version).toBe(3);
  });

  it('rejects a required column that is not on the board', async () => {
    const { boardId, settings } = await setup('WF 5');
    const bad = { ...WORKFLOW, transitions: [{ from: 0, to: 1, required: ['nope'] }] };
    expect(
      (await as(admin).patch(`/boards/${boardId}/columns/stage`, { settings: { ...settings, workflow: bad } })).status,
    ).toBe(400);
  });

  it('an automation follows the workflow (a blocked move is skipped, not an error) unless it bypasses', async () => {
    const run = async (boardId: string, done: string) => {
      const id = newId();
      await t.db.insert(automations).values({
        id,
        accountId: acmeId,
        boardId,
        title: 'Finish',
        recipe: {
          trigger: { type: 'item_created' },
          actions: [{ type: 'set_status', column: 'stage', label: done }],
        } as never,
        isActive: true,
        ownerId: adminId,
        createdBy: adminId,
      });
      const itemId = await newItem(boardId);
      const [created] = await t.db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(eq(activityLog.itemId, itemId), eq(activityLog.type, 'item.created')));
      for (const runId of await dispatchEvent(t.deps, created!.id)) await executeRun(t.deps, runId);
      const [row] = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));
      const [auto] = await t.db.select().from(automations).where(eq(automations.id, id));
      return { itemId, row: row!, auto: auto! };
    };
    const six = await setup('WF 6');
    const doneOf = (x: Json) => (x.labels as Json[]).find((l) => l.id === 1)!.label as string;
    const obey = await run(six.boardId, doneOf(six.settings));
    expect(obey.row.status).toBe('skipped');
    expect(JSON.stringify(obey.row.actionsLog)).toContain('workflow_blocked:required');
    expect(obey.auto.consecutiveErrors).toBe(0);
    expect(await stageOf(obey.itemId)).toEqual({ index: 0 });

    const { boardId, settings } = await setup('WF 7');
    await as(admin).patch(`/boards/${boardId}/columns/stage`, {
      settings: { ...settings, workflow: { ...WORKFLOW, automations: 'bypass' } },
    });
    const bypass = await run(boardId, doneOf(settings));
    expect(bypass.row.status).toBe('succeeded');
    expect(await stageOf(bypass.itemId)).toEqual({ index: 1 });
  });

  it('phase 2: a move with a popup needs its fields and its note; the note becomes an update', async () => {
    const { boardId, settings } = await setup('WF 8');
    const popupFlow = {
      ...WORKFLOW,
      transitions: [{ from: 0, to: 2, popup: { fields: [{ column_id: 'note', required: true }], note: 'required' } }],
    };
    expect(
      (await as(admin).patch(`/boards/${boardId}/columns/stage`, { settings: { ...settings, workflow: popupFlow } }))
        .status,
    ).toBe(200);
    const id = await newItem(boardId);
    const noField = await as(bob).patch(`/items/${id}`, { cells: { stage: { index: 2 } } });
    expect(noField.status).toBe(409);
    expect(JSON.stringify(await body(noField))).toContain('"reason":"required"');
    const noNote = await as(bob).patch(`/items/${id}`, { cells: { stage: { index: 2 }, note: 'why' } });
    expect(noNote.status).toBe(409);
    expect(JSON.stringify(await body(noNote))).toContain('"reason":"note"');
    expect(await stageOf(id)).toEqual({ index: 0 }); // nothing of the refused write stays
    const ok = await as(bob).patch(`/items/${id}`, {
      cells: { stage: { index: 2 }, note: 'why' },
      note: 'Waiting for the client\nsecond line',
    });
    expect(ok.status).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 2 });
    const updates = JSON.stringify(await body(await as(admin).get(`/items/${id}/updates`)));
    expect(updates).toContain('Waiting for the client');
    // A popup column that is not on the board is refused when saved.
    const bad = { ...WORKFLOW, transitions: [{ from: 0, to: 2, popup: { fields: [{ column_id: 'nope' }] } }] };
    expect(
      (await as(admin).patch(`/boards/${boardId}/columns/stage`, { settings: { ...settings, workflow: bad } })).status,
    ).toBe(400);
  });

  it('phase 2: a popup button saves its answers, its note and the click together', async () => {
    const { boardId } = await setup('WF 9');
    const button = await as(admin).post(`/boards/${boardId}/columns`, {
      id: 'ask',
      title: 'Ask',
      type: 'button',
      settings: {
        action: { kind: 'popup', popup: { fields: [{ column_id: 'note', required: true }], note: 'optional' } },
      },
    });
    expect(button.status).toBe(201);
    const id = await newItem(boardId);
    const missing = await as(bob).post(`/items/${id}/buttons/ask`, {});
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await body(missing))).toContain('popup_required');
    const foreign = await as(bob).post(`/items/${id}/buttons/ask`, { cells: { stage: { index: 2 } } });
    expect(foreign.status).toBe(422);
    const res = await as(bob).post(`/items/${id}/buttons/ask`, {
      cells: { note: 'filled' },
      note: 'clicked with a note',
    });
    expect(res.status).toBe(200);
    expect((await body(res)).written).toEqual(['note']);
    expect((await body(await as(admin).get(`/items/${id}`))).cells.note?.value).toBe('filled');
    expect(JSON.stringify(await body(await as(admin).get(`/items/${id}/updates`)))).toContain('clicked with a note');
  });
});
