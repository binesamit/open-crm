// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, IHookFunctions, ILoadOptionsFunctions } from 'n8n-workflow';
import { BinesOs } from '../nodes/BinesOs/BinesOs.node';
import { BinesOsTrigger } from '../nodes/BinesOsTrigger/BinesOsTrigger.node';
import { checkExists, configOf, create } from '../nodes/BinesOsTrigger/hooks';
import { apiEventOf } from '../nodes/shared/constants';
import {
  getColumnFields,
  getColumns,
  getLabels,
  getStatusColumns,
  getSubitemColumnFields,
  getSubitemColumns,
  searchFilterValues,
  searchFindValues,
} from '../nodes/shared/loadOptions';
import {
  choiceValue,
  locatorValue,
  mapperFields,
  toCellValue,
  type BoardSchema,
  type ColumnChoice,
  type IntegrationColumn,
} from '../nodes/shared/values';
import { BASE, SCHEMA, makeCtx, type Call } from './mock';

/**
 * 0.2.0: subitems everywhere (sub-board columns in the mapper and pickers, subitem operations and triggers) and value
 * pickers for columns with predefined values (labels, people, tags, connected items).
 */
const API = `${BASE}/api/v1`;
const path = (c: Call) => c.url.replace(API, '');

const column = (id: string, type: string, value_model: string, extra: Partial<IntegrationColumn> = {}) =>
  ({
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    type,
    description: null,
    writable: true,
    value_model,
    options: null,
    value_schema: null,
    ...extra,
  }) as IntegrationColumn;

/** A board with people, tags and a connect-boards column — and its sub-board. */
const RICH: BoardSchema = {
  ...SCHEMA,
  columns: [
    ...SCHEMA.columns,
    column('tags', 'tags', 'tags'),
    column('client', 'board_relation', 'links', { linked_board_ids: ['b9'] }),
    column('kind', 'dropdown', 'labels', {
      options: [
        { id: 3, label: 'Lead', color: null },
        { id: 4, label: 'Customer', color: null },
      ],
    }),
  ],
};

const CHOICES: Record<string, ColumnChoice[]> = {
  owner: [
    { id: 'u1', text: 'Dana Levi', hint: 'dana@example.com' },
    { id: 'u2', text: 'Avi Cohen', hint: null },
  ],
  tags: [{ id: '01JBTAG0000000000000000000', text: 'vip', hint: null }],
  client: [{ id: 'i77', text: 'Acme Ltd', hint: 'Clients' }],
  stage: [
    { id: '0', text: 'To do', hint: null },
    { id: '5', text: 'Blocked', hint: null },
  ],
};

const instance =
  (extra: (c: Call) => unknown = () => undefined) =>
  (c: Call) => {
    const x = extra(c);
    if (x !== undefined) return x;
    // The sub-board's own schema: its columns are the subitem columns.
    if (c.url.endsWith('/boards/b1s/schema'))
      return { ...RICH, id: 'b1s', columns: RICH.subitems!.columns, subitems: null };
    if (c.url.endsWith('/schema')) return RICH;
    const choice = /\/columns\/([^/]+)\/choices$/.exec(c.url);
    if (choice) return { kind: 'labels', data: CHOICES[choice[1]!] ?? [] };
    return { id: 's1', board_id: 'b1s', parent_item_id: 'p1', name: 'Task', cells: {} };
  };

const run = async (
  params: Record<string, unknown> | Record<string, unknown>[],
  route: (c: Call) => unknown,
  input?: IDataObject[],
) => {
  const ctx = makeCtx({ params, route, input });
  const out = await new BinesOs().execute.call(ctx as unknown as IExecuteFunctions);
  return { ctx, rows: out[0]!.map((r) => r.json) };
};
const asLoad = (ctx: ReturnType<typeof makeCtx>) => ctx as unknown as ILoadOptionsFunctions;

describe('subitem columns load from the sub-board', () => {
  it('the subitem mapper shows the sub-board columns; status labels to pick', async () => {
    const ctx = makeCtx({ params: { resource: 'subitem', boardId: 'b1' }, route: instance() });
    const { fields } = await getSubitemColumnFields.call(asLoad(ctx));
    expect(fields.map((f) => f.id)).toEqual(['hours', 'stage']);
    expect(fields[1]).toMatchObject({
      type: 'options',
      options: [
        { name: 'To do', value: 0 },
        { name: 'Blocked', value: 5 },
      ],
    });
  });

  it('a board with no subitems yet says so instead of "choose a board"', async () => {
    const ctx = makeCtx({
      params: { resource: 'subitem', boardId: 'b1' },
      route: instance((c) => (c.url.endsWith('/schema') ? { ...RICH, subitems: null } : undefined)),
    });
    const res = await getSubitemColumnFields.call(asLoad(ctx));
    expect(res.fields).toEqual([]);
    expect(res.emptyFieldsNotice).toMatch(/no subitems yet/);
  });

  it('column, status column and label pickers follow the resource / the trigger event', async () => {
    const sub = makeCtx({ params: { resource: 'subitem', boardId: 'b1', statusColumnId: 'stage' }, route: instance() });
    expect((await getColumns.call(asLoad(sub))).map((o) => o.value)).toEqual(['name', 'hours', 'stage']);
    expect((await getLabels.call(asLoad(sub))).map((o) => o.value)).toEqual(['', 'To do', 'Blocked']);
    const trigger = makeCtx({ params: { event: 'subitem_status_changed', boardId: 'b1' }, route: instance() });
    expect((await getStatusColumns.call(asLoad(trigger))).map((o) => o.value)).toEqual(['stage']);
    expect((await getSubitemColumns.call(asLoad(trigger))).map((o) => o.value)).toEqual(['', 'hours', 'stage']);
    const items = makeCtx({ params: { resource: 'item', boardId: 'b1' }, route: instance() });
    expect((await getStatusColumns.call(asLoad(items))).map((o) => o.value)).toEqual(['status']);
  });
});

describe('value pickers', () => {
  it('the item mapper offers people, tags, connected items and dropdown labels to pick', async () => {
    const ctx = makeCtx({ params: { resource: 'item', boardId: 'b1' }, route: instance() });
    const { fields } = await getColumnFields.call(asLoad(ctx));
    const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
    expect(byId.owner).toMatchObject({
      type: 'options',
      options: [
        { name: 'Dana Levi (dana@example.com)', value: 'u1' },
        { name: 'Avi Cohen', value: 'u2' },
      ],
    });
    expect(byId.tags!.options).toEqual([{ name: 'vip', value: '01JBTAG0000000000000000000' }]);
    expect(byId.client!.options).toEqual([{ name: 'Acme Ltd (Clients)', value: 'i77' }]);
    expect(byId.kind!.options).toEqual([
      { name: 'Lead', value: 3 },
      { name: 'Customer', value: 4 },
    ]);
    expect(byId.phone).toMatchObject({ type: 'string' });
    // One choices call per column that needs one (labels come with the schema).
    expect(
      ctx.calls
        .filter((c) => c.url.includes('/choices'))
        .map(path)
        .sort(),
    ).toEqual([
      '/boards/b1/columns/client/choices',
      '/boards/b1/columns/owner/choices',
      '/boards/b1/columns/tags/choices',
    ]);
  });

  it('find searches the column values as text; a filter takes ids; subitems ask the sub-board', async () => {
    const find = makeCtx({ params: { resource: 'item', boardId: 'b1', columnId: 'owner' }, route: instance() });
    const found = await searchFindValues.call(asLoad(find), 'da');
    expect(found.results.map((r) => r.value)).toEqual(['Dana Levi', 'Avi Cohen']);
    expect(find.calls[0]).toMatchObject({
      url: `${API}/boards/b1/columns/owner/choices`,
      qs: { q: 'da', subitems: 'false' },
    });
    const filter = makeCtx({ params: { resource: 'item', boardId: 'b1', columnId: 'owner' }, route: instance() });
    expect((await searchFilterValues.call(asLoad(filter))).results.map((r) => r.value)).toEqual(['u1', 'u2']);
    const sub = makeCtx({ params: { resource: 'subitem', boardId: 'b1', columnId: 'stage' }, route: instance() });
    expect((await searchFindValues.call(asLoad(sub))).results.map((r) => r.value)).toEqual(['To do', 'Blocked']);
    expect(sub.calls[0]!.qs).toMatchObject({ subitems: 'true' });
  });

  it('values: choices by purpose, resource-locator values, tags and connected items', () => {
    const c: ColumnChoice = { id: 'u1', text: 'Dana', hint: null };
    expect(choiceValue(c, 'find')).toBe('Dana');
    expect(choiceValue(c, 'write')).toBe('u1');
    expect(choiceValue({ id: null, text: 'free', hint: null }, 'filter')).toBe('free');
    expect(locatorValue({ __rl: true, mode: 'list', value: 'Done' })).toBe('Done');
    expect(locatorValue('050-1')).toBe('050-1');
    expect(locatorValue(undefined)).toBe('');
    const tags = column('tags', 'tags', 'tags');
    expect(toCellValue(tags, '01JBTAG0000000000000000000')).toEqual({ tag_ids: ['01JBTAG0000000000000000000'] });
    expect(toCellValue(tags, 'vip, 01JBTAG0000000000000000000')).toEqual({
      tag_ids: ['01JBTAG0000000000000000000'],
      tags: ['vip'],
    });
    expect(toCellValue(column('client', 'board_relation', 'links'), 'i1, i2, i1')).toEqual({ item_ids: ['i1', 'i2'] });
    // Without loaded choices a people column stays a typed field.
    expect(mapperFields([column('owner', 'people', 'people')])[0]).toMatchObject({ type: 'string' });
  });
});

describe('subitem operations', () => {
  it('create and update use their own mapper and the sub-board columns', async () => {
    const { ctx } = await run(
      [
        {
          resource: 'subitem',
          operation: 'create',
          boardId: 'b1',
          itemId: 'p1',
          name: 'Task',
          subitemColumns: { mappingMode: 'defineBelow', value: { stage: 5, hours: '1' } },
        },
        {
          resource: 'subitem',
          operation: 'update',
          boardId: 'b1',
          itemId: 's1',
          name: '',
          subitemColumns: { mappingMode: 'defineBelow', value: { stage: 'to do' } },
        },
      ],
      instance(),
      [{}, {}],
    );
    const writes = ctx.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [`${c.method} ${path(c)}`, c.body])).toEqual([
      ['POST /items/p1/subitems', { name: 'Task', cells: { stage: { index: 5 }, hours: 1 } }],
      ['PATCH /items/s1', { cells: { stage: { index: 0 } } }],
    ]);
  });

  it('get, get many of an item, move, archive, delete', async () => {
    const { ctx, rows } = await run(
      [
        { resource: 'subitem', operation: 'get', itemId: 's1' },
        { resource: 'subitem', operation: 'getForItem', itemId: 'p1' },
        { resource: 'subitem', operation: 'move', itemId: 's1', parentItemId: 'p2', position: 'top' },
        { resource: 'subitem', operation: 'archive', itemId: 's1' },
        { resource: 'subitem', operation: 'delete', itemId: 's1' },
      ],
      instance((c) =>
        c.url.endsWith('/items/p1/subitems') && c.method === 'GET'
          ? { data: [{ id: 's1', board_id: 'b1s', cells: { stage: { value: { index: 5 }, text: 'Blocked' } } }] }
          : undefined,
      ),
      [{}, {}, {}, {}, {}],
    );
    const calls = ctx.calls.filter((c) => !c.url.endsWith('/schema'));
    expect(calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      'GET /items/s1',
      'GET /items/p1/subitems',
      'POST /items/s1/reparent',
      'POST /items/s1/archive',
      'DELETE /items/s1',
    ]);
    expect(calls[2]!.body).toEqual({ parent_item_id: 'p2', position: 'top' });
    expect(rows[1]).toMatchObject({ id: 's1', column_values: { Stage: 'Blocked' } });
  });

  it('find and get many run on the sub-board (picked values included)', async () => {
    const { ctx, rows } = await run(
      [
        {
          resource: 'subitem',
          operation: 'find',
          boardId: 'b1',
          columnId: 'stage',
          value: { __rl: true, mode: 'list', value: 'Blocked' },
          match: 'exact',
          limit: 5,
        },
        {
          resource: 'subitem',
          operation: 'getAll',
          boardId: 'b1',
          returnAll: true,
          filters: {
            rules: [{ columnId: 'stage', operator: 'any_of', value: { __rl: true, mode: 'list', value: '5' } }],
          },
        },
      ],
      instance((c) => {
        if (c.url.endsWith('/items/find')) return { data: [{ id: 's9', board_id: 'b1s', cells: {} }] };
        if (c.url.endsWith('/items/query')) return { data: [{ id: 's8' }], next_cursor: null };
        return undefined;
      }),
      [{}, {}],
    );
    const find = ctx.calls.find((c) => c.url.endsWith('/items/find'))!;
    expect(find).toMatchObject({
      url: `${API}/boards/b1s/items/find`,
      body: { column_id: 'stage', value: 'Blocked', match: 'exact', limit: 5 },
    });
    const query = ctx.calls.find((c) => c.url.endsWith('/items/query'))!;
    expect(path(query)).toBe('/boards/b1s/items/query');
    expect((query.body as IDataObject).filter).toMatchObject({
      rules: [{ column_id: 'stage', operator: 'any_of', values: ['5'] }],
    });
    expect(rows.map((r) => r.id)).toEqual(['s9', 's8']);
  });

  it('item find still takes a value saved as plain text (0.1 workflows)', async () => {
    const { ctx } = await run(
      { resource: 'item', operation: 'find', boardId: 'b1', columnId: 'phone', value: '050-1234567', limit: 5 },
      instance((c) => (c.url.endsWith('/items/find') ? { data: [] } : undefined)),
    );
    expect(ctx.calls[0]!.body).toMatchObject({ column_id: 'phone', value: '050-1234567' });
  });

  it('a subitem operation on a board without subitems fails clearly', async () => {
    await expect(
      run(
        { resource: 'subitem', operation: 'find', boardId: 'b1', columnId: 'stage', value: 'x' },
        instance((c) => (c.url.endsWith('/schema') ? { ...RICH, subitems: null } : undefined)),
      ),
    ).rejects.toThrow(/has no subitems yet/);
  });
});

describe('subitem triggers', () => {
  const base = { boardId: 'b1', includeItem: true };

  it('narrow the subitem column change by column, type and label', () => {
    expect(configOf({ ...base, event: 'subitem_column_changed', subitemColumnId: 'hours' })).toEqual({
      include_item: true,
      column_id: 'hours',
    });
    expect(configOf({ ...base, event: 'subitem_column_changed' })).toEqual({ include_item: true });
    expect(configOf({ ...base, event: 'subitem_status_changed', statusColumnId: 'stage', label: 'Blocked' })).toEqual({
      include_item: true,
      column_type: 'status',
      column_id: 'stage',
      label: 'Blocked',
    });
    expect(apiEventOf('subitem_status_changed')).toBe('subitem_column_changed');
    expect(apiEventOf('subitem_created')).toBe('subitem_created');
  });

  it('"Subitem Status Changed" subscribes to the platform event and is recognised as its own', async () => {
    const params = {
      boardId: 'b1',
      event: 'subitem_status_changed',
      statusColumnId: 'stage',
      label: 'Blocked',
      options: {},
    };
    const ctx = makeCtx({ params, route: () => ({ id: 'w5' }) });
    expect(await create.call(ctx as unknown as IHookFunctions)).toBe(true);
    expect(ctx.calls[0]!.body).toMatchObject({
      event: 'subitem_column_changed',
      config: { column_type: 'status', column_id: 'stage', label: 'Blocked' },
    });
    const again = makeCtx({
      params,
      staticData: { webhookId: 'w5' },
      route: () => ({
        id: 'w5',
        url: 'https://n8n.example.com/webhook/abc/webhook',
        event: 'subitem_column_changed',
        is_active: true,
      }),
    });
    expect(await checkExists.call(again as unknown as IHookFunctions)).toBe(true);
  });

  it('the trigger offers every subitem event with its pickers', () => {
    const props = new BinesOsTrigger().description.properties;
    const events = (props.find((p) => p.name === 'event')!.options as { value: string }[]).map((o) => o.value);
    expect(events).toEqual(
      expect.arrayContaining([
        'subitem_created',
        'subitem_column_changed',
        'subitem_status_changed',
        'subitem_name_changed',
        'subitem_archived',
        'subitem_deleted',
        'subitem_update_created',
      ]),
    );
    expect(props.find((p) => p.name === 'subitemColumnId')!.displayOptions!.show!.event).toEqual([
      'subitem_column_changed',
    ]);
    expect(props.find((p) => p.name === 'label')!.displayOptions!.show!.event).toContain('subitem_status_changed');
  });

  it('the action node lists the subitem operations and the value search methods', () => {
    const node = new BinesOs();
    const ops = node.description.properties.find(
      (p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes('subitem'),
    )!.options as { value: string }[];
    expect(ops.map((o) => o.value).sort()).toEqual(
      ['archive', 'create', 'delete', 'find', 'get', 'getAll', 'getForItem', 'move', 'moveUp', 'update'].sort(),
    );
    expect(Object.keys(node.methods.listSearch)).toEqual(['searchFindValues', 'searchFilterValues']);
    const locators = node.description.properties.filter((p) => p.type === 'resourceLocator');
    for (const p of locators)
      expect(Object.keys(node.methods.listSearch)).toContain(p.modes![0]!.typeOptions!.searchListMethod);
  });
});
