// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, automationRuns } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Product decision: subitem and sub-subitem columns in automations — "when a subitem's column changes"
 * (the sub-board's columns, its own conditions, a level), parent / subitem actions and `{parent.*}` / `{subitem.*}`.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let subBoardId: string;
let parentId: string;
let subId: string;
let subSubId: string;
let mainText: string;
let mainOnly: string;
let subText: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const seen = new Set<string>();
const drain = async () => {
  const runs: string[] = [];
  for (let round = 0; round < 20; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) {
        runs.push(runId);
        await executeRun(t.deps, runId);
      }
    }
  }
  return runs;
};
const runsOf = (automationId: string) =>
  t.db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(asc(automationRuns.createdAt));
const getItem = async (id: string) => body(await as().get(`/items/${id}`));
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });
const create = async (recipe: Json, title = 'A') => as().post(`/boards/${boardId}/automations`, { title, recipe });
const off = async (id: string) => as().post(`/automations/${id}/deactivate`, {});

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
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Projects', workspace_id: wsId }))).id;
  mainText = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'הערות', type: 'text' }))).id;
  // A column only the board has (the sub-board starts with name, people, status, date).
  mainOnly = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'תקציב', type: 'numbers' }))).id;
  parentId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Parent' }))).id;
  subId = (await body(await as().post(`/items/${parentId}/subitems`, { name: 'Sub' }))).id;
  subSubId = (await body(await as().post(`/items/${subId}/subitems`, { name: 'SubSub' }))).id;
  subBoardId = (await getItem(subId)).board_id;
  subText = (await body(await as().post(`/boards/${subBoardId}/columns`, { title: 'פירוט', type: 'text' }))).id;
  await drain(); // setup events: nothing listens yet
});
afterAll(() => t.close());

describe('subitem columns in automations (D14)', () => {
  it('a subitem trigger names a sub-board column; the board’s own column is refused', async () => {
    const bad = await create({
      trigger: { type: 'subitem_column_changed', column: mainOnly },
      actions: [{ type: 'notify', to: '@board_owners', message: 'x' }],
    });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.details.issues[0]).toMatchObject({
      path: 'trigger.column',
      code: 'column_not_found',
    });
    // A subitem's own actions write the sub-board's columns; the parent's column is refused there.
    const wrongSide = await create({
      trigger: { type: 'subitem_column_changed', column: subText },
      actions: [{ type: 'set_column', column: mainOnly, value: '1' }],
    });
    expect(wrongSide.status).toBe(422);
    // A board item has no parent.
    const noParent = await create({
      trigger: { type: 'item_created' },
      actions: [{ type: 'set_parent_column', column: mainOnly, value: '1' }],
    });
    expect((await body(noParent)).error.details.issues[0]).toMatchObject({ code: 'no_parent' });
  });

  it('"when a subitem’s column changes" → set the parent’s column, with {subitem.*} and {parent.*}', async () => {
    const res = await create({
      trigger: { type: 'subitem_column_changed', column: subText },
      // Conditions read the subitem (the sub-board's columns).
      conditions: {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [{ kind: 'rule', column_id: subText, operator: 'is_not_empty', values: [], negate: false }],
      },
      actions: [
        {
          type: 'set_parent_column',
          column: mainText,
          value: `{parent.name}: {subitem.name} = {item.${subText}}`,
        },
      ],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    await setCell(subId, subText, 'ready');
    await drain();
    const parent = await getItem(parentId);
    expect(parent.cells[mainText].text).toBe('Parent: Sub = ready');
    const runs = await runsOf(a.id);
    expect(runs.at(-1)!.status).toBe('succeeded');
    await off(a.id);
  });

  it('a level: only sub-subitems; their parent is a subitem', async () => {
    const res = await create({
      trigger: { type: 'subitem_column_changed', column: subText, level: 'sub_subitem' },
      actions: [{ type: 'copy_to_parent', source: subText, column: subText }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    await setCell(subId, subText, 'from-sub'); // a subitem: not heard
    await drain();
    expect(await runsOf(a.id)).toHaveLength(0);
    await setCell(subSubId, subText, 'from-subsub');
    await drain();
    expect((await getItem(subId)).cells[subText].text).toBe('from-subsub');
    await off(a.id);
  });

  it('for each subitem (that matches) set a column; copy the parent’s value down', async () => {
    const res = await create({
      trigger: { type: 'column_changed', column: mainText },
      actions: [
        {
          type: 'set_subitems_column',
          column: subText,
          value: 'done by {item.name}',
          where: {
            kind: 'group',
            operator: 'and',
            negate: false,
            rules: [{ kind: 'rule', column_id: subText, operator: 'is_not_empty', values: [], negate: false }],
          },
        },
      ],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    const sub2 = (await body(await as().post(`/items/${parentId}/subitems`, { name: 'Sub2' }))).id;
    await drain();
    await setCell(parentId, mainText, 'go');
    await drain();
    expect((await getItem(subId)).cells[subText].text).toBe('done by Parent');
    // Sub2 had nothing: filtered out.
    expect((await getItem(sub2)).cells[subText]?.text ?? '').toBe('');
    await off(a.id);

    const copy = await body(
      await create({
        trigger: { type: 'column_changed', column: mainText },
        actions: [{ type: 'copy_to_subitems', source: mainText, column: subText }],
      }),
    );
    await setCell(parentId, mainText, 'copied');
    await drain();
    expect((await getItem(sub2)).cells[subText].text).toBe('copied');
    await off(copy.id);
  });

  it('a new subitem copies from its parent; the status of the parent follows "all subitems"', async () => {
    const res = await create({
      trigger: { type: 'subitem_created' },
      actions: [{ type: 'copy_from_parent', source: mainText, column: subText }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    const sub3 = (await body(await as().post(`/items/${parentId}/subitems`, { name: 'Sub3' }))).id;
    await drain();
    expect((await getItem(sub3)).cells[subText].text).toBe((await getItem(parentId)).cells[mainText].text);
    await off(a.id);
  });

  it('a dry run takes a subitem of the board for a subitem trigger', async () => {
    const a = await body(
      await create({
        trigger: { type: 'subitem_column_changed', column: subText },
        actions: [{ type: 'set_column', column: subText, value: '{parent.name}' }],
      }),
    );
    const res = await as().post(`/automations/${a.id}/test`, { item_id: subId, dry_run: true });
    expect(res.status).toBe(200);
    expect((await body(res)).actions[0].rendered.value).toBe('Parent');
    await off(a.id);
  });

  it('the sentence reads the sub-board’s column titles', async () => {
    // The default title: a subitem's action column is a sub-board column.
    const res = await as().post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'subitem_column_changed', column: subText },
        actions: [{ type: 'set_column', column: subText, value: 'x' }],
      },
      is_active: false,
    });
    expect(res.status).toBe(201);
    expect((await body(res)).title).toContain('פירוט');
  });
});
