// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions, INodeProperties } from 'n8n-workflow';
import { BinesOsApi } from '../credentials/BinesOsApi.credentials';
import { BinesOs } from '../nodes/BinesOs/BinesOs.node';
import { BinesOsTrigger } from '../nodes/BinesOsTrigger/BinesOsTrigger.node';
import { PRODUCT_NAME } from '../nodes/shared/constants';
import { getColumnFields, getLabels } from '../nodes/shared/loadOptions';
import { normalizeBaseUrl } from '../nodes/shared/transport';
import { BASE, MEMBERS, SCHEMA, makeCtx, type Call } from './mock';

const API = `${BASE}/api/v1`;

/** The usual answers of a fake instance. */
const instance =
  (extra: (c: Call) => unknown = () => undefined) =>
  (c: Call) => {
    const x = extra(c);
    if (x !== undefined) return x;
    if (c.url.endsWith('/schema')) return SCHEMA;
    if (c.url === `${API}/users`) return { data: MEMBERS };
    return { id: 'i1', board_id: 'b1', name: 'Dana', cells: { status: { value: { index: 1 }, text: 'Done' } } };
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

describe('credentials and transport', () => {
  it('sends the token as a bearer header and tests with /auth/me', () => {
    const c = new BinesOsApi();
    expect(c.displayName).toBe(`${PRODUCT_NAME} API`);
    expect(c.authenticate.properties.headers).toEqual({ Authorization: '=Bearer {{$credentials.apiToken}}' });
    expect(c.test.request.url).toBe('/auth/me');
    expect(String(c.test.request.baseURL)).toContain('/api/v1');
  });

  it('accepts the instance URL with or without a trailing slash or /api/v1', () => {
    expect(normalizeBaseUrl('https://crm.example.com/')).toBe('https://crm.example.com');
    expect(normalizeBaseUrl(' https://crm.example.com/api/v1/ ')).toBe('https://crm.example.com');
  });
});

describe('node description', () => {
  const methodsOf = (props: INodeProperties[]): string[] =>
    props.flatMap((p) => [
      ...(p.typeOptions?.loadOptionsMethod ? [p.typeOptions.loadOptionsMethod as string] : []),
      ...(p.typeOptions?.resourceMapper?.resourceMapperMethod
        ? [p.typeOptions.resourceMapper.resourceMapperMethod]
        : []),
      ...((p.options as INodeProperties[] | undefined)?.flatMap((o) =>
        'values' in o ? methodsOf((o as unknown as { values: INodeProperties[] }).values) : [],
      ) ?? []),
    ]);

  it('every picker has its method', () => {
    for (const node of [new BinesOs(), new BinesOsTrigger()]) {
      const known = [
        ...Object.keys(node.methods.loadOptions),
        ...Object.keys((node.methods as { resourceMapping?: object }).resourceMapping ?? {}),
      ];
      for (const m of methodsOf(node.description.properties)) expect(known, m).toContain(m);
    }
  });

  it('every resource has operations, every operation an action', () => {
    const d = new BinesOs().description;
    const resources = (d.properties.find((p) => p.name === 'resource')!.options as { value: string }[]).map(
      (o) => o.value,
    );
    for (const r of resources) {
      const ops = d.properties.filter((p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(r));
      expect(ops, r).toHaveLength(1);
      for (const o of ops[0]!.options as { action?: string }[]) expect(o.action).toBeTruthy();
    }
    expect(d.usableAsTool).toBe(true);
  });
});

describe('item operations', () => {
  it('create: converts the mapped values by column type and loads people only when needed', async () => {
    const { ctx, rows } = await run(
      {
        resource: 'item',
        operation: 'create',
        boardId: 'b1',
        name: 'Dana',
        groupId: 'g2',
        columns: {
          mappingMode: 'defineBelow',
          value: { status: 'Done', owner: 'dana@example.com', due: '2026-10-06', phone: '', country: 'IL' },
        },
      },
      instance(),
    );
    const post = ctx.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${API}/boards/b1/items`);
    expect(post.body).toEqual({
      name: 'Dana',
      group_id: 'g2',
      cells: {
        status: { index: 1 },
        owner: { persons_and_teams: [{ id: 'u1', kind: 'person' }] },
        due: { date: '2026-10-06' },
        country: { code: 'IL' },
      },
    });
    expect(rows[0]).toMatchObject({ id: 'i1', column_values: { Status: 'Done' } });
    // One schema load for the whole run.
    expect(ctx.calls.filter((c) => c.url.endsWith('/schema'))).toHaveLength(1);
  });

  it('create: "map automatically" takes the input fields by column id or title', async () => {
    const { ctx } = await run(
      { resource: 'item', operation: 'create', boardId: 'b1', name: 'X', columns: { mappingMode: 'autoMapInputData' } },
      instance(),
      [{ Status: 'New', phone: '0501234567', unrelated: 1 }],
    );
    expect((ctx.calls.find((c) => c.method === 'POST')!.body as IDataObject).cells).toEqual({
      status: { index: 0 },
      phone: { phone: '0501234567' },
    });
  });

  it('create: a wrong value fails with the column name', async () => {
    await expect(
      run(
        {
          resource: 'item',
          operation: 'create',
          boardId: 'b1',
          name: 'X',
          columns: { mappingMode: 'defineBelow', value: { status: 'Lost' } },
        },
        instance(),
      ),
    ).rejects.toThrow(/not a label of "Status"/);
  });

  it('update, move to group, archive, duplicate, delete, get', async () => {
    const base = { resource: 'item', boardId: 'b1', itemId: 'i1' };
    const { ctx } = await run(
      [
        {
          ...base,
          operation: 'update',
          name: 'New name',
          columns: { mappingMode: 'defineBelow', value: { status: 'New' } },
        },
        { ...base, operation: 'moveToGroup', groupId: 'g2' },
        { ...base, operation: 'archive' },
        { ...base, operation: 'duplicate', withUpdates: true },
        { ...base, operation: 'delete' },
        { ...base, operation: 'get' },
      ],
      instance(),
      [{}, {}, {}, {}, {}, {}],
    );
    const writes = ctx.calls.filter((c) => !c.url.endsWith('/schema'));
    expect(writes.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'PATCH /items/i1',
      'POST /items/i1/move-to-group',
      'POST /items/i1/archive',
      'POST /items/i1/duplicate',
      'DELETE /items/i1',
      'GET /items/i1',
    ]);
    expect(writes[0]!.body).toEqual({ name: 'New name', cells: { status: { index: 0 } } });
    expect(writes[1]!.body).toEqual({ group_id: 'g2' });
    expect(writes[3]!.body).toEqual({ with_updates: true });
  });

  it('move to board: maps the columns automatically', async () => {
    const target = { ...SCHEMA, id: 'b2', columns: SCHEMA.columns.filter((c) => c.id !== 'phone') };
    const { ctx } = await run(
      { resource: 'item', operation: 'moveToBoard', itemId: 'i1', targetBoardId: 'b2', targetGroupId: '' },
      instance((c) => (c.url.endsWith('/boards/b2/schema') ? target : undefined)),
    );
    const move = ctx.calls.find((c) => c.url.endsWith('/move-to-board'))!;
    expect(move.body).toMatchObject({ board_id: 'b2', mapping: { status: 'status', phone: null } });
  });

  it('find by column value', async () => {
    const { ctx, rows } = await run(
      {
        resource: 'item',
        operation: 'find',
        boardId: 'b1',
        columnId: 'phone',
        value: '050-1234567',
        match: 'exact',
        limit: 5,
      },
      instance((c) =>
        c.url.endsWith('/items/find') ? { data: [{ id: 'i9', board_id: 'b1', cells: {} }] } : undefined,
      ),
    );
    expect(ctx.calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/boards/b1/items/find`,
      body: { column_id: 'phone', value: '050-1234567', match: 'exact', limit: 5 },
    });
    expect(rows.map((r) => r.id)).toEqual(['i9']);
  });

  it('get many: builds the filter and follows the cursor', async () => {
    let page = 0;
    const { ctx, rows } = await run(
      {
        resource: 'item',
        operation: 'getAll',
        boardId: 'b1',
        returnAll: true,
        search: 'dana',
        filters: { rules: [{ columnId: 'status', operator: 'any_of', value: 'New, Done' }] },
      },
      instance((c) =>
        c.url.endsWith('/items/query')
          ? page++ === 0
            ? { data: [{ id: 'a' }], next_cursor: 'c1' }
            : { data: [{ id: 'b' }], next_cursor: null }
          : undefined,
      ),
    );
    const queries = ctx.calls.filter((c) => c.url.endsWith('/items/query'));
    expect(queries).toHaveLength(2);
    expect(queries[0]!.body).toMatchObject({
      search: 'dana',
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ column_id: 'status', operator: 'any_of', values: ['New', 'Done'] }],
      },
    });
    expect((queries[1]!.body as IDataObject).cursor).toBe('c1');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('other resources', () => {
  it('subitem create uses the sub-board columns', async () => {
    const { ctx } = await run(
      {
        resource: 'subitem',
        operation: 'create',
        boardId: 'b1',
        itemId: 'p1',
        name: 'Task',
        columns: { mappingMode: 'defineBelow', value: { hours: '2.5' } },
      },
      instance(),
    );
    const post = ctx.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${API}/items/p1/subitems`);
    expect(post.body).toEqual({ name: 'Task', cells: { hours: 2.5 } });
  });

  it('updates: post and reply', async () => {
    const { ctx } = await run(
      [
        { resource: 'update', operation: 'create', itemId: 'i1', body: 'Hello' },
        { resource: 'update', operation: 'reply', updateId: 'u9', body: 'Thanks' },
      ],
      instance(),
      [{}, {}],
    );
    expect(ctx.calls.map((c) => [c.url.replace(API, ''), c.body])).toEqual([
      ['/items/i1/updates', { body: 'Hello' }],
      ['/updates/u9/replies', { body: 'Thanks' }],
    ]);
  });

  it('file upload: presign, PUT without the token, complete, attach', async () => {
    const ctx = makeCtx({
      params: {
        resource: 'file',
        operation: 'upload',
        boardId: 'b1',
        itemId: 'i1',
        columnId: 'files',
        binaryPropertyName: 'data',
      },
      binary: { fileName: 'quote.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1') },
      route: (c) => {
        if (c.url.endsWith('/files/presign'))
          return {
            file_id: 'f1',
            upload_url: 'https://s3.example.com/put?sig=1',
            method: 'PUT',
            headers: { 'content-type': 'application/pdf' },
          };
        return { id: 'f1', ok: true };
      },
    });
    await new BinesOs().execute.call(ctx as unknown as IExecuteFunctions);
    expect(ctx.calls.map((c) => `${c.method} ${c.url.replace(API, '')} ${c.auth ? 'auth' : 'plain'}`)).toEqual([
      'POST /files/presign auth',
      'PUT https://s3.example.com/put?sig=1 plain',
      'POST /files/f1/complete auth',
      'POST /items/i1/cells/files/files auth',
    ]);
    expect(ctx.calls[0]!.body).toEqual({ name: 'quote.pdf', size: 6, mime: 'application/pdf' });
    expect(ctx.calls[3]!.body).toEqual({ file_ids: ['f1'] });
  });

  it('group create, agent run, users, boards, API call', async () => {
    const { ctx } = await run(
      [
        { resource: 'group', operation: 'create', boardId: 'b1', title: 'Hot' },
        { resource: 'agent', operation: 'run', agentId: 'a1', prompt: 'Summarise', agentOptions: { itemId: 'i1' } },
        { resource: 'user', operation: 'getAll', returnAll: false, limit: 1, q: '' },
        { resource: 'board', operation: 'getAll', returnAll: true, q: 'lea' },
        {
          resource: 'apiCall',
          operation: 'call',
          method: 'POST',
          path: '/api/v1/boards/b1/items/count',
          query: '{"q":"x"}',
          body: '{}',
        },
      ],
      instance((c) => (c.url.endsWith('/boards') ? { data: [{ id: 'b1' }] } : undefined)),
      [{}, {}, {}, {}, {}],
    );
    expect(ctx.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'POST /boards/b1/groups',
      'POST /agents/a1/runs',
      'GET /users',
      'GET /boards',
      'POST /boards/b1/items/count',
    ]);
    expect(ctx.calls[1]!.body).toEqual({ prompt: 'Summarise', item_id: 'i1' });
    expect(ctx.calls[3]!.qs).toEqual({ q: 'lea' });
    expect(ctx.calls[4]!.qs).toEqual({ q: 'x' });
  });
});

describe('dynamic fields', () => {
  it("the mapper loads the chosen board's columns; labels follow the status column", async () => {
    const ctx = makeCtx({ params: { boardId: 'b1', statusColumnId: 'status' }, route: instance() });
    const fields = await getColumnFields.call(ctx as unknown as ILoadOptionsFunctions);
    expect(fields.fields.map((f) => f.id)).toContain('status');
    const labels = await getLabels.call(ctx as unknown as ILoadOptionsFunctions);
    expect(labels.map((l) => l.value)).toEqual(['', 'New', 'Done']);
  });
});
