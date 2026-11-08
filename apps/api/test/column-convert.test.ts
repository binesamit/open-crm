// SPDX-License-Identifier: AGPL-3.0-only
import { newId, rankBetween } from '@bines/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { auditLog, cells, columnConversionCells, columns, notifications } from '../src/db/schema';
import { insertCells, insertItems } from '../src/modules/items/items.repo';
import { purgeConversionBackups } from '../src/modules/conversions/jobs';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** D28 — column type conversion: preview = conversion, backup + restore, undo, dependents, permissions, scale. */
let t: TestContext;
let admin: string;
let bob: string; // member, not a board owner
let other: string; // admin of another account
let acmeId: string;
let betaId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, account = acmeId) => t.api(cookie, account);
const db = () => t.db as unknown as Db;

const newBoard = async (name: string) =>
  (await body(await as(admin).post('/boards', { name, workspace_id: wsId }))).id as string;
const addColumn = async (boardId: string, type: string, title = type, settings?: Json) =>
  (await body(await as(admin).post(`/boards/${boardId}/columns`, { title, type, ...(settings ? { settings } : {}) })))
    .id as string;
const newItem = async (boardId: string, name: string) =>
  (await body(await as(admin).post(`/boards/${boardId}/items`, { name }))).id as string;
const setCell = (itemId: string, key: string, value: unknown) =>
  as(admin).put(`/items/${itemId}/cells/${key}`, { value });
const item = async (id: string) => body(await as(admin).get(`/items/${id}`));
const column = async (boardId: string, key: string) =>
  (await body(await as(admin).get(`/boards/${boardId}`))).columns.find((c: Json) => c.id === key) as Json;
const convert = (cookie: string, boardId: string, key: string, payload: Json) =>
  as(cookie).post(`/boards/${boardId}/columns/${key}/convert`, payload);
const preview = async (boardId: string, key: string, to: string, options?: Json) => {
  const res = await convert(admin, boardId, key, { to_type: to, dry_run: true, ...(options ? { options } : {}) });
  expect(res.status).toBe(200);
  return (await body(res)).preview as Json;
};
/** Preview, then convert with its fingerprint. */
const run = async (boardId: string, key: string, to: string, options?: Json) => {
  const p = await preview(boardId, key, to, options);
  const res = await convert(admin, boardId, key, {
    to_type: to,
    fingerprint: p.fingerprint,
    ...(options ? { options } : {}),
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return { preview: p, conversion: (await body(res)).conversion as Json };
};

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  other = await join('admin@beta.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
}, 60_000);
afterAll(() => t.close());

describe('text → numbers', () => {
  it('the preview counts are what the conversion writes; a failure keeps its value in the backup', async () => {
    const boardId = await newBoard('Amounts');
    const key = await addColumn(boardId, 'text', 'Amount');
    const a = await newItem(boardId, 'a');
    const b = await newItem(boardId, 'b');
    const c = await newItem(boardId, 'c');
    await newItem(boardId, 'empty');
    await setCell(a, key, '1,250 ₪');
    await setCell(b, key, '₪ 300');
    await setCell(c, key, 'בערך 5');

    const { preview: p, conversion } = await run(boardId, key, 'numbers');
    expect(p.counts).toEqual({ items: 4, converted: 2, empty: 1, failed: 1, partial: 0 });
    expect(p.samples.failed).toEqual([expect.objectContaining({ item_id: c, item_name: 'c', before: 'בערך 5' })]);
    expect(p.to_settings.unit).toEqual({ symbol: '₪', direction: 'left' });
    expect(conversion).toMatchObject({
      status: 'done',
      from_type: 'text',
      to_type: 'numbers',
      counts: p.counts,
      backup: true,
      failed_marked: true,
    });

    expect((await column(boardId, key)).type).toBe('numbers');
    expect((await item(a)).cells[key]).toMatchObject({ value: 1250 });
    expect((await item(b)).cells[key]).toMatchObject({ value: 300 });
    expect((await item(c)).cells[key]).toBeUndefined();
    // The failed cell's original value is kept and shown.
    const failed = await body(await as(admin).get(`/boards/${boardId}/conversions/failed`));
    expect(failed.data).toEqual([
      expect.objectContaining({ conversion_id: conversion.id, column_id: key, items: { [c]: 'בערך 5' } }),
    ]);
    const backup = await t.db
      .select()
      .from(columnConversionCells)
      .where(eq(columnConversionCells.conversionId, conversion.id));
    expect(backup).toHaveLength(3);
    // One event, one audit row.
    const log = await body(await as(admin).get(`/boards/${boardId}/activity`));
    expect(log.data.filter((e: Json) => e.type === 'column.type_changed')).toHaveLength(1);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'column.type_changed'));
    expect(audit.some((r) => (r.payload as Json).conversion_id === conversion.id)).toBe(true);

    // Clearing the marks keeps the backup.
    expect((await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/clear-failed`)).status).toBe(200);
    expect((await body(await as(admin).get(`/boards/${boardId}/conversions/failed`))).data).toEqual([]);

    // Undo (as from the toast): type, settings and every value back.
    const undo = await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect((await column(boardId, key)).type).toBe('text');
    expect((await item(a)).cells[key].value).toBe('1,250 ₪');
    expect((await item(c)).cells[key].value).toBe('בערך 5');
    expect((await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/undo`, {})).status).toBe(409);
    const history = await body(await as(admin).get(`/boards/${boardId}/conversions?column_id=${key}`));
    expect(history.data[0]).toMatchObject({ id: conversion.id, status: 'undone' });
  });

  it('needs the preview, and a preview the column moved past is refused', async () => {
    const boardId = await newBoard('Stale');
    const key = await addColumn(boardId, 'text');
    const a = await newItem(boardId, 'a');
    await setCell(a, key, '5');
    expect((await convert(admin, boardId, key, { to_type: 'numbers' })).status).toBe(400);
    const p = await preview(boardId, key, 'numbers');
    await setCell(a, key, 'שש');
    const res = await convert(admin, boardId, key, { to_type: 'numbers', fingerprint: p.fingerprint });
    expect(res.status).toBe(409);
    const err = await body(res);
    expect(err.error.code).toBe('preview_stale');
    expect(err.error.details.preview.counts.failed).toBe(1);
  });

  it('an undo after the values were edited asks first (changed_since), then forces', async () => {
    const boardId = await newBoard('Edited');
    const key = await addColumn(boardId, 'text');
    const a = await newItem(boardId, 'a');
    await setCell(a, key, '7');
    const { conversion } = await run(boardId, key, 'numbers');
    expect((await item(a)).cells[key].value).toBe(7);
    await setCell(a, key, 8);
    const undo = await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/undo`, {});
    expect(undo.status).toBe(409);
    expect((await body(undo)).error.code).toBe('changed_since');
    expect((await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/undo`, { force: true })).status).toBe(
      200,
    );
    expect((await item(a)).cells[key].value).toBe('7');
  });
});

describe('text → status', () => {
  it('creates the labels the values need; the undo takes them away with the type', async () => {
    const boardId = await newBoard('Stages');
    const key = await addColumn(boardId, 'text', 'Stage');
    const ids = [await newItem(boardId, 'a'), await newItem(boardId, 'b'), await newItem(boardId, 'c')];
    await setCell(ids[0]!, key, 'בטיפול');
    await setCell(ids[1]!, key, 'Done');
    await setCell(ids[2]!, key, 'done');
    const p = await preview(boardId, key, 'status');
    expect(p.new_labels.map((l: Json) => [l.name, l.count])).toEqual([
      ['בטיפול', 1],
      ['Done', 2],
    ]);
    // Remove one new label: its cells fail (and stay in the backup).
    const skip = await preview(boardId, key, 'status', { skip_labels: ['done'] });
    expect(skip.counts).toMatchObject({ converted: 1, failed: 2 });
    expect(skip.skipped_labels).toEqual([{ name: 'Done', count: 2 }]);

    const { conversion } = await run(boardId, key, 'status', { label_colors: { done: 'blue' } });
    const col = await column(boardId, key);
    expect(col.type).toBe('status');
    expect(col.settings.labels.map((l: Json) => [l.label, l.color])).toEqual([
      ['בטיפול', expect.stringMatching(/^[a-z]+$/)],
      ['Done', 'blue'],
    ]);
    expect((await item(ids[2]!)).cells[key].text).toBe('Done');

    await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/undo`, {});
    const back = await column(boardId, key);
    expect(back.type).toBe('text');
    expect(back.settings.labels).toBeUndefined();
    expect((await item(ids[2]!)).cells[key].value).toBe('done');
  });

  it('status → dropdown keeps label ids; dropdown → status keeps the first label (the rest in the backup)', async () => {
    const boardId = await newBoard('Labels');
    const key = await addColumn(boardId, 'dropdown', 'Tags', {
      labels: [
        { id: 1, label: 'אדום' },
        { id: 2, label: 'כחול' },
      ],
    });
    const a = await newItem(boardId, 'a');
    await setCell(a, key, { ids: [2, 1] });
    const { preview: p } = await run(boardId, key, 'status');
    expect(p.counts).toMatchObject({ converted: 1, partial: 1 });
    expect((await item(a)).cells[key].value).toEqual({ index: 2 });
    await run(boardId, key, 'dropdown');
    expect((await item(a)).cells[key].value).toEqual({ ids: [2] });
  });
});

describe('dependents', () => {
  it('disables saved rules, switches off automations that no longer fit, flags formulas — and the undo restores them', async () => {
    const boardId = await newBoard('Deps');
    const status = await addColumn(boardId, 'status', 'S');
    const num = await addColumn(boardId, 'numbers', 'N');
    await addColumn(boardId, 'formula', 'F', { formula: `{${num}} * 2` });
    const a = await newItem(boardId, 'a');
    await setCell(a, num, 5);
    const labels = (await column(boardId, status)).settings.labels as Json[];
    await setCell(a, status, { index: labels[0]!.id });

    const view = await body(
      await as(admin).post(`/boards/${boardId}/views`, {
        name: 'Big',
        settings: {
          query: {
            filter: {
              kind: 'group',
              operator: 'and',
              rules: [{ column_id: num, operator: 'greater_than', values: [1] }],
            },
          },
          summaries: { [num]: 'sum' },
        },
      }),
    );
    const auto = await body(
      await as(admin).post(`/boards/${boardId}/automations`, {
        title: 'On done',
        recipe: {
          trigger: { type: 'status_changed', column: status, labels: [labels[0]!.label] },
          actions: [{ type: 'notify', to: '@owner', message: 'x' }],
        },
      }),
    );
    expect(auto.is_active).toBe(true);

    // numbers → text: the view's rule is disabled, the formula flagged.
    const p = await preview(boardId, num, 'text');
    const kinds = p.dependents.map((d: Json) => `${d.kind}:${d.action}`);
    expect(kinds).toEqual(expect.arrayContaining(['formula:review', 'view:disabled']));
    const { conversion } = await run(boardId, num, 'text');
    expect(conversion.dependents).toEqual(p.dependents);
    const saved = (await body(await as(admin).get(`/boards/${boardId}/views`))).data.find(
      (v: Json) => v.id === view.id,
    );
    expect(saved.settings.query.filter.rules[0].disabled).toBe(`column_type_changed:${conversion.id}`);
    expect(saved.settings.summaries[num]).toBeUndefined();
    // The board still loads its items (a disabled rule is ignored).
    expect((await as(admin).get(`/boards/${boardId}/items`)).status).toBe(200);

    await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/undo`, {});
    const restored = (await body(await as(admin).get(`/boards/${boardId}/views`))).data.find(
      (v: Json) => v.id === view.id,
    );
    expect(restored.settings.query.filter.rules[0].disabled).toBeUndefined();
    expect(restored.settings.summaries[num]).toBe('sum');

    // status → text: the status trigger no longer fits — the automation is switched off, its owner told.
    const s = await run(boardId, status, 'text');
    expect(s.conversion.dependents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'automation', id: auto.id, action: 'disabled' })]),
    );
    const off = await body(await as(admin).get(`/automations/${auto.id}`));
    expect(off.is_active).toBe(false);
    const notes = await t.db.select().from(notifications).where(eq(notifications.type, 'automation'));
    expect(notes.some((n) => (n.payload as Json).automation_deactivated?.automation_id === auto.id)).toBe(true);
    await as(admin).post(`/boards/${boardId}/conversions/${s.conversion.id}/undo`, {});
    expect((await body(await as(admin).get(`/automations/${auto.id}`))).is_active).toBe(true);
  });
});

describe('restore from backup', () => {
  it('goes back to the original type and values (a conversion of its own, which can be undone)', async () => {
    const boardId = await newBoard('Restore');
    const key = await addColumn(boardId, 'text');
    const a = await newItem(boardId, 'a');
    const b = await newItem(boardId, 'b');
    await setCell(a, key, '12');
    await setCell(b, key, 'x');
    const { conversion } = await run(boardId, key, 'numbers');
    const dry = await body(
      await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/restore`, { dry_run: true }),
    );
    expect(dry.preview).toMatchObject({ to_type: 'text', changed_since: 0 });
    const res = await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/restore`, {
      fingerprint: dry.preview.fingerprint,
    });
    expect(res.status).toBe(200);
    const restore = (await body(res)).conversion;
    expect(restore).toMatchObject({ kind: 'restore', restore_of: conversion.id, to_type: 'text', status: 'done' });
    expect((await column(boardId, key)).type).toBe('text');
    expect((await item(a)).cells[key].value).toBe('12');
    expect((await item(b)).cells[key].value).toBe('x');
    // The restore can be undone like a conversion.
    expect((await as(admin).post(`/boards/${boardId}/conversions/${restore.id}/undo`, {})).status).toBe(200);
    expect((await column(boardId, key)).type).toBe('numbers');
  });

  it('old backups are removed by the retention job (the history stays, without restore)', async () => {
    const boardId = await newBoard('Purge');
    const key = await addColumn(boardId, 'text');
    await setCell(await newItem(boardId, 'a'), key, '1');
    const { conversion } = await run(boardId, key, 'numbers');
    expect(await purgeConversionBackups(db(), new Date(Date.now() + 91 * 86_400_000))).toBeGreaterThan(0);
    const after = await body(await as(admin).get(`/boards/${boardId}/conversions/${conversion.id}`));
    expect(after.backup).toBe(false);
    expect(
      (await as(admin).post(`/boards/${boardId}/conversions/${conversion.id}/restore`, { dry_run: true })).status,
    ).toBe(422);
    // Retention is an admin setting.
    expect((await as(bob).put('/conversions/settings', { backup_days: 30 })).status).toBe(403);
    expect(await body(await as(admin).put('/conversions/settings', { backup_days: 365 }))).toEqual({
      backup_days: 365,
    });
  });
});

describe('permissions and isolation', () => {
  it('only board owners and admins convert; another account sees nothing; unsupported pairs say why', async () => {
    const boardId = await newBoard('Perm');
    const key = await addColumn(boardId, 'text');
    expect((await convert(bob, boardId, key, { to_type: 'numbers', dry_run: true })).status).toBe(403);
    expect(
      (
        await t
          .api(other, betaId)
          .post(`/boards/${boardId}/columns/${key}/convert`, { to_type: 'numbers', dry_run: true })
      ).status,
    ).toBe(404);
    expect((await t.api(other, betaId).get(`/boards/${boardId}/conversions`)).status).toBe(404);
    const formula = await addColumn(boardId, 'formula', 'F', { formula: '1' });
    const bad = await convert(admin, boardId, formula, { to_type: 'text', dry_run: true });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error).toMatchObject({ code: 'conversion_unsupported', details: { reason: 'computed' } });
    expect((await convert(admin, boardId, 'name', { to_type: 'text', dry_run: true })).status).toBe(422);
  });

  it('cell edits wait while a background conversion runs (423)', async () => {
    const boardId = await newBoard('Locked');
    const key = await addColumn(boardId, 'text');
    const a = await newItem(boardId, 'a');
    const col = (
      await t.db
        .select()
        .from(columns)
        .where(and(eq(columns.boardId, boardId), eq(columns.key, key)))
    )[0]!;
    await t.db.update(columns).set({ convertingId: 'x' }).where(eq(columns.id, col.id));
    expect((await setCell(a, key, 'v')).status).toBe(423);
    expect((await convert(admin, boardId, key, { to_type: 'numbers', dry_run: true })).status).toBe(423);
    expect((await column(boardId, key)).converting).toBe('x');
    await t.db.update(columns).set({ convertingId: null }).where(eq(columns.id, col.id));
    expect((await setCell(a, key, 'v')).status).toBe(200);
  });
});

describe('a large board', () => {
  it('20,000 items convert in windows (the background path), counts and values right', async () => {
    const boardId = await newBoard('Big board');
    const key = await addColumn(boardId, 'text', 'Amount');
    const board = await body(await as(admin).get(`/boards/${boardId}`));
    const groupId = board.groups[0].id as string;
    const col = (
      await t.db
        .select()
        .from(columns)
        .where(and(eq(columns.boardId, boardId), eq(columns.key, key)))
    )[0]!;
    const N = 20_000;
    const ids: string[] = [];
    let pos: string | null = null;
    const rows = [];
    for (let i = 0; i < N; i++) {
      pos = rankBetween(pos, null);
      const id = newId();
      ids.push(id);
      rows.push({ id, accountId: acmeId, boardId, groupId, position: pos, name: `item ${i}` });
    }
    await insertItems(db(), rows);
    await insertCells(
      db(),
      ids.map((id, i) => ({
        itemId: id,
        columnId: col.id,
        accountId: acmeId,
        boardId,
        value: (i % 100 === 0 ? 'לא מספר' : `${i},000 ₪`) as never,
        textValue: i % 100 === 0 ? 'לא מספר' : `${i},000 ₪`,
      })),
    );
    const p = await preview(boardId, key, 'numbers');
    expect(p.background).toBe(true);
    expect(p.counts).toMatchObject({ items: N, converted: N - 200, failed: 200, empty: 0 });
    const res = await convert(admin, boardId, key, { to_type: 'numbers', fingerprint: p.fingerprint });
    expect(res.status).toBe(200);
    const conv = (await body(res)).conversion;
    // Without a job runner (tests) the windows run in the request; with one the same code runs in the job.
    expect(conv).toMatchObject({ status: 'done', total: N, done: N, counts: p.counts });
    expect((await column(boardId, key)).converting).toBeNull();
    const stored = await t.db.select().from(cells).where(eq(cells.columnId, col.id));
    expect(stored).toHaveLength(N - 200);
    expect(stored.find((c) => c.itemId === ids[1])?.numberValue).toBe(1000);
    // One undo brings all 20,000 back.
    expect((await as(admin).post(`/boards/${boardId}/conversions/${conv.id}/undo`, {})).status).toBe(200);
    expect(await t.db.select().from(cells).where(eq(cells.columnId, col.id))).toHaveLength(N);
  }, 180_000);
});
