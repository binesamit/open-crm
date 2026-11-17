// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { BinesOs } from '../nodes/BinesOs/BinesOs.node';
import { TRIGGER_EVENTS } from '../nodes/shared/constants';
import { BASE, SCHEMA, makeCtx, type Call } from './mock';

/**
 * 0.3.0: item templates, time tracking, links in a files column, an update's check boxes, a subitem
 * up a level, group update / delete, a new column, search, teams, and the newer trigger events — all additions; the
 * 0.2 operations keep their names and fields.
 */
const API = `${BASE}/api/v1`;

const run = async (params: Record<string, unknown>, route: (c: Call) => unknown = () => ({ ok: true })) => {
  const ctx = makeCtx({
    params,
    route: (c) => (c.url.endsWith('/schema') ? SCHEMA : route(c)),
  });
  const out = await new BinesOs().execute.call(ctx as unknown as IExecuteFunctions);
  const writes = ctx.calls.filter((c) => !c.url.endsWith('/schema'));
  return { writes, rows: out[0]!.map((r) => r.json) };
};

describe('0.3.0 operations', () => {
  it('applies an item template and returns the new item with what the run did', async () => {
    const { writes, rows } = await run(
      {
        resource: 'item',
        operation: 'applyTemplate',
        boardId: 'b1',
        templateId: 't1',
        templateOptions: { groupId: 'g2', variables: '{"name":"Acme"}' },
      },
      (c) =>
        c.method === 'POST'
          ? { item_id: 'i9', created: 3, batch_id: 'bt', skipped: [] }
          : { id: 'i9', board_id: 'b1', name: 'Acme', cells: {} },
    );
    expect(writes[0]).toMatchObject({
      method: 'POST',
      url: `${API}/item-templates/t1/apply`,
      body: { group_id: 'g2', position: 'bottom', variables: { name: 'Acme' } },
    });
    expect(writes[1]).toMatchObject({ method: 'GET', url: `${API}/items/i9` });
    expect(rows[0]).toMatchObject({ id: 'i9', template: { created: 3, batch_id: 'bt' } });
  });

  it('starts, stops and logs time on a timer column', async () => {
    const start = await run({
      resource: 'time',
      operation: 'start',
      boardId: 'b1',
      itemId: 'i1',
      columnId: 'timer',
      note: ' call ',
    });
    expect(start.writes[0]).toMatchObject({
      method: 'POST',
      url: `${API}/items/i1/time/start`,
      body: { column_id: 'timer', note: 'call' },
    });
    const stop = await run({ resource: 'time', operation: 'stop', boardId: 'b1', itemId: 'i1', columnId: 'timer' });
    expect(stop.writes[0]).toMatchObject({ url: `${API}/items/i1/time/stop`, body: { column_id: 'timer' } });
    const entry = await run({
      resource: 'time',
      operation: 'addEntry',
      boardId: 'b1',
      itemId: 'i1',
      columnId: 'timer',
      startedAt: '2026-10-29T08:00:00Z',
      minutes: 90,
    });
    expect(entry.writes[0]!.body).toEqual({
      column_id: 'timer',
      started_at: '2026-10-29T08:00:00.000Z',
      duration_s: 5400,
    });
    const log = await run({ resource: 'time', operation: 'getEntries', itemId: 'i1' }, () => ({
      data: [{ id: 'e1' }, { id: 'e2' }],
    }));
    expect(log.rows.map((r: IDataObject) => r.id)).toEqual(['e1', 'e2']);
  });

  it('adds a link to a files column, ticks an update check box (counted from 1), moves a subitem up', async () => {
    const link = await run({
      resource: 'file',
      operation: 'addLink',
      boardId: 'b1',
      itemId: 'i1',
      columnId: 'files',
      url: ' example.com/brief ',
      linkName: 'Brief',
    });
    expect(link.writes[0]).toMatchObject({
      url: `${API}/items/i1/cells/files/links`,
      body: { url: 'example.com/brief', name: 'Brief' },
    });
    const tick = await run({ resource: 'update', operation: 'tickTask', updateId: 'u1', index: 2, checked: true });
    expect(tick.writes[0]).toMatchObject({ method: 'PUT', url: `${API}/updates/u1/tasks/1`, body: { checked: true } });
    const up = await run({ resource: 'subitem', operation: 'moveUp', itemId: 's1' });
    expect(up.writes[0]).toMatchObject({ method: 'POST', url: `${API}/items/s1/outdent` });
  });

  it('updates and deletes a group, creates a column', async () => {
    const upd = await run({
      resource: 'group',
      operation: 'update',
      boardId: 'b1',
      groupId: 'g1',
      title: 'Done',
    });
    expect(upd.writes[0]).toMatchObject({
      method: 'PATCH',
      url: `${API}/boards/b1/groups/g1`,
      body: { title: 'Done' },
    });
    const del = await run({ resource: 'group', operation: 'delete', boardId: 'b1', groupId: 'g1' });
    expect(del.writes[0]).toMatchObject({ method: 'DELETE', url: `${API}/boards/b1/groups/g1` });
    const col = await run({
      resource: 'column',
      operation: 'create',
      boardId: 'b1',
      title: 'Budget',
      columnType: 'numbers',
      description: '',
    });
    expect(col.writes[0]).toMatchObject({
      method: 'POST',
      url: `${API}/boards/b1/columns`,
      body: { title: 'Budget', type: 'numbers' },
    });
  });

  it('searches (2+ characters) and lists teams', async () => {
    const s = await run({ resource: 'search', operation: 'search', q: 'acme', archived: true }, () => ({ items: [] }));
    expect(s.writes[0]).toMatchObject({ method: 'GET', url: `${API}/search`, qs: { q: 'acme', archived: '1' } });
    await expect(run({ resource: 'search', operation: 'search', q: 'a' })).rejects.toThrow(/2 characters/);
    const t = await run({ resource: 'user', operation: 'getTeams' }, () => ({ data: [{ id: 't1' }] }));
    expect(t.rows).toEqual([{ id: 't1' }]);
  });
});

describe('0.3.0 trigger events', () => {
  it('offers the newer platform events', () => {
    const values = TRIGGER_EVENTS.map((e) => e.value);
    for (const e of [
      'item_restored',
      'item_moved_to_board',
      'update_edited',
      'update_deleted',
      'file_added',
      'group_created',
      'column_created',
      'column_type_changed',
    ])
      expect(values).toContain(e);
  });
});
