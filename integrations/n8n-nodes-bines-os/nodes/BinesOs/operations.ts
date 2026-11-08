// SPDX-License-Identifier: MIT
import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestMethods,
  type ResourceMapperValue,
} from 'n8n-workflow';
import { apiQueryAll, apiRequest, normalizeBaseUrl } from '../shared/transport';
import { CREDENTIAL_NAME } from '../shared/constants';
import { nodeError } from '../shared/errors';
import {
  autoMapping,
  locatorValue,
  needsMembers,
  simplifyItem,
  toCells,
  ValueError,
  type BoardSchema,
  type IntegrationColumn,
  type Member,
} from '../shared/values';

/** What one execution loads once and reuses across its items: board schemas and the member list. */
export type RunCache = { schemas: Map<string, BoardSchema>; members?: Member[] };

type Ctx = IExecuteFunctions;
const enc = encodeURIComponent;

const get = (ctx: Ctx, path: string, qs?: IDataObject, i?: number) =>
  apiRequest.call(ctx, 'GET', path, undefined, qs, i) as Promise<IDataObject>;
const send = (ctx: Ctx, method: IHttpRequestMethods, path: string, body: IDataObject, i?: number) =>
  apiRequest.call(ctx, method, path, body, undefined, i) as Promise<IDataObject>;

export const schemaOf = async (ctx: Ctx, cache: RunCache, boardId: string, i?: number) => {
  let s = cache.schemas.get(boardId);
  if (!s) {
    s = (await get(ctx, `/boards/${enc(boardId)}/schema`, undefined, i)) as unknown as BoardSchema;
    cache.schemas.set(boardId, s);
  }
  return s;
};

const membersOf = async (ctx: Ctx, cache: RunCache, i: number) =>
  (cache.members ??= ((await get(ctx, '/users', { status: 'active' }, i)).data as Member[]) ?? []);

/** The mapper's parameter: subitems have their own (`subitemColumns`; workflows of 0.1 saved it as `columns`). */
const mapperOf = (ctx: Ctx, i: number, subitems: boolean): Partial<ResourceMapperValue> => {
  const own = subitems
    ? (ctx.getNodeParameter('subitemColumns', i, null) as Partial<ResourceMapperValue> | null)
    : null;
  return own ?? (ctx.getNodeParameter('columns', i, {}) as Partial<ResourceMapperValue>);
};

/** The mapper's values: "define below" → what was typed; "map automatically" → the input item's matching fields. */
const mappedValues = (ctx: Ctx, i: number, columns: IntegrationColumn[], subitems = false): Record<string, unknown> => {
  const mapper = mapperOf(ctx, i, subitems);
  if (mapper.mappingMode === 'autoMapInputData') {
    const json = ctx.getInputData()[i]?.json ?? {};
    const out: Record<string, unknown> = {};
    for (const c of columns.filter((x) => x.writable)) {
      if (c.id in json) out[c.id] = json[c.id];
      else if (c.title in json) out[c.id] = json[c.title];
    }
    return out;
  }
  return { ...(mapper.value ?? {}) };
};

const cellsFor = async (ctx: Ctx, cache: RunCache, i: number, columns: IntegrationColumn[], subitems = false) => {
  const values = mappedValues(ctx, i, columns, subitems);
  const members = needsMembers(columns, values) ? await membersOf(ctx, cache, i) : [];
  try {
    return toCells(columns, values, members);
  } catch (e) {
    if (e instanceof ValueError) throw new NodeOperationError(ctx.getNode(), e.message, { itemIndex: i });
    throw nodeError(ctx.getNode(), e, i);
  }
};

const item = async (ctx: Ctx, cache: RunCache, res: IDataObject, i: number) => {
  const boardId = res.board_id as string | undefined;
  const columns = boardId ? (await schemaOf(ctx, cache, boardId, i).catch(() => null))?.columns : undefined;
  return simplifyItem(res, columns);
};

const param = <T = string>(ctx: Ctx, name: string, i: number, fallback?: T) =>
  ctx.getNodeParameter(name, i, fallback as never) as T;

/** The sub-board of the chosen parent board (subitems live there); fails clearly when there is none yet. */
const subBoardOf = async (ctx: Ctx, cache: RunCache, i: number) => {
  const s = await schemaOf(ctx, cache, param(ctx, 'boardId', i), i);
  if (!s.subitems)
    throw new NodeOperationError(ctx.getNode(), `The board "${s.name}" has no subitems yet`, { itemIndex: i });
  return s.subitems;
};

/** The body of a cursor-paged query: free-text search and the filter conditions (all must match). */
const queryBody = (ctx: Ctx, i: number): IDataObject => {
  const rules = (param<IDataObject>(ctx, 'filters', i, {}).rules as IDataObject[] | undefined) ?? [];
  const search = param(ctx, 'search', i, '').trim();
  const list = (v: unknown) =>
    locatorValue(v)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const used = rules.filter((r) => r.columnId);
  return {
    ...(search ? { search } : {}),
    ...(used.length
      ? {
          filter: {
            kind: 'group',
            operator: 'and',
            rules: used.map((r) => ({
              kind: 'rule',
              column_id: r.columnId,
              operator: r.operator,
              values:
                r.operator === 'is_empty' || r.operator === 'is_not_empty'
                  ? []
                  : r.operator === 'any_of' || r.operator === 'not_any_of'
                    ? list(r.value)
                    : [locatorValue(r.value)],
            })),
          },
        }
      : {}),
  };
};

const findBody = (ctx: Ctx, i: number): IDataObject => ({
  column_id: param(ctx, 'columnId', i),
  value: locatorValue(param<unknown>(ctx, 'value', i, '')).trim(),
  match: param(ctx, 'match', i, 'exact'),
  limit: param<number>(ctx, 'limit', i, 10),
});

/** A JSON field's value: an object as it is, a JSON text parsed (empty = `{}`). */
const parseJsonValue = (ctx: Ctx, name: string, v: unknown, i: number): IDataObject => {
  if (v && typeof v === 'object') return v as IDataObject;
  try {
    return (JSON.parse(String(v || '{}')) as IDataObject) ?? {};
  } catch {
    throw new NodeOperationError(ctx.getNode(), `"${name}" is not valid JSON`, { itemIndex: i });
  }
};

const parseJson = (ctx: Ctx, name: string, i: number): IDataObject =>
  parseJsonValue(ctx, name, ctx.getNodeParameter(name, i, '{}'), i);

/** Runs one operation for input item `i`; returns the output rows. */
export const runOperation = async (
  ctx: Ctx,
  cache: RunCache,
  resource: string,
  operation: string,
  i: number,
): Promise<IDataObject[]> => {
  const key = `${resource}:${operation}`;
  switch (key) {
    // ── items ──────────────────────────────────────────────────────────────────────────────────────────────
    case 'item:create': {
      const boardId = param(ctx, 'boardId', i);
      const s = await schemaOf(ctx, cache, boardId, i);
      const groupId = param(ctx, 'groupId', i, '');
      const body: IDataObject = { name: param(ctx, 'name', i), cells: await cellsFor(ctx, cache, i, s.columns) };
      if (groupId) body.group_id = groupId;
      return [await item(ctx, cache, await send(ctx, 'POST', `/boards/${enc(boardId)}/items`, body, i), i)];
    }
    case 'item:update':
    case 'subitem:update': {
      const s = await schemaOf(ctx, cache, param(ctx, 'boardId', i), i);
      const sub = resource === 'subitem';
      const columns = sub ? (s.subitems?.columns ?? []) : s.columns;
      const body: IDataObject = { cells: await cellsFor(ctx, cache, i, columns, sub) };
      const name = param(ctx, 'name', i, '').trim();
      if (name) body.name = name;
      return [await item(ctx, cache, await send(ctx, 'PATCH', `/items/${enc(param(ctx, 'itemId', i))}`, body, i), i)];
    }
    case 'item:get':
    case 'subitem:get':
      return [await item(ctx, cache, await get(ctx, `/items/${enc(param(ctx, 'itemId', i))}`, undefined, i), i)];
    case 'item:delete':
    case 'subitem:delete':
      return [await send(ctx, 'DELETE', `/items/${enc(param(ctx, 'itemId', i))}`, {}, i)];
    case 'item:archive':
    case 'subitem:archive':
      return [await send(ctx, 'POST', `/items/${enc(param(ctx, 'itemId', i))}/archive`, {}, i)];
    case 'item:duplicate': {
      const res = await send(
        ctx,
        'POST',
        `/items/${enc(param(ctx, 'itemId', i))}/duplicate`,
        { with_updates: param<boolean>(ctx, 'withUpdates', i, false) },
        i,
      );
      return [res.board_id ? await item(ctx, cache, res, i) : res];
    }
    case 'item:moveToGroup':
      return [
        await item(
          ctx,
          cache,
          await send(
            ctx,
            'POST',
            `/items/${enc(param(ctx, 'itemId', i))}/move-to-group`,
            { group_id: param(ctx, 'groupId', i) },
            i,
          ),
          i,
        ),
      ];
    case 'item:moveToBoard': {
      const itemId = param(ctx, 'itemId', i);
      const target = param(ctx, 'targetBoardId', i);
      const current = await get(ctx, `/items/${enc(itemId)}`, undefined, i);
      const [from, to] = await Promise.all([
        schemaOf(ctx, cache, current.board_id as string, i),
        schemaOf(ctx, cache, target, i),
      ]);
      const groupId = param(ctx, 'targetGroupId', i, '');
      const res = await send(
        ctx,
        'POST',
        `/items/${enc(itemId)}/move-to-board`,
        { board_id: target, ...(groupId ? { group_id: groupId } : {}), mapping: autoMapping(from.columns, to.columns) },
        i,
      );
      return [res];
    }
    case 'item:find':
    case 'subitem:find': {
      const boardId = resource === 'subitem' ? (await subBoardOf(ctx, cache, i)).board_id : param(ctx, 'boardId', i);
      const res = await send(ctx, 'POST', `/boards/${enc(boardId)}/items/find`, findBody(ctx, i), i);
      return Promise.all(((res.data as IDataObject[]) ?? []).map((x) => item(ctx, cache, x, i)));
    }
    case 'item:getAll':
    case 'subitem:getAll': {
      const returnAll = param<boolean>(ctx, 'returnAll', i, false);
      const max = returnAll ? 0 : param<number>(ctx, 'limit', i, 50);
      let boardId = param(ctx, 'boardId', i);
      let columns: IntegrationColumn[];
      if (resource === 'subitem') {
        const sub = await subBoardOf(ctx, cache, i);
        boardId = sub.board_id;
        columns = sub.columns;
      } else columns = (await schemaOf(ctx, cache, boardId, i)).columns;
      const rows = await apiQueryAll.call(ctx, `/boards/${enc(boardId)}/items/query`, queryBody(ctx, i), max, i);
      return rows.map((r) => simplifyItem(r, columns));
    }
    case 'item:applyTemplate': {
      const o = param<IDataObject>(ctx, 'templateOptions', i, {});
      const variables = o.variables === undefined ? {} : parseJsonValue(ctx, 'variables', o.variables, i);
      const res = await send(
        ctx,
        'POST',
        `/item-templates/${enc(param(ctx, 'templateId', i))}/apply`,
        {
          ...(o.groupId ? { group_id: o.groupId } : {}),
          ...(o.parentItemId ? { parent_item_id: o.parentItemId } : {}),
          position: (o.position as string) || 'bottom',
          variables,
        },
        i,
      );
      // The applied item itself, with what the template run says (count, one-undo batch, values it skipped).
      const applied = await item(ctx, cache, await get(ctx, `/items/${enc(res.item_id as string)}`, undefined, i), i);
      return [{ ...applied, template: res }];
    }
    // ── subitems ───────────────────────────────────────────────────────────────────────────────────────────
    case 'subitem:moveUp':
      return [await send(ctx, 'POST', `/items/${enc(param(ctx, 'itemId', i))}/outdent`, {}, i)];
    case 'subitem:create': {
      const s = await schemaOf(ctx, cache, param(ctx, 'boardId', i), i);
      const body: IDataObject = {
        name: param(ctx, 'name', i),
        cells: await cellsFor(ctx, cache, i, s.subitems?.columns ?? [], true),
      };
      return [
        await item(ctx, cache, await send(ctx, 'POST', `/items/${enc(param(ctx, 'itemId', i))}/subitems`, body, i), i),
      ];
    }
    case 'subitem:getForItem': {
      const res = await get(ctx, `/items/${enc(param(ctx, 'itemId', i))}/subitems`, undefined, i);
      return Promise.all(((res.data as IDataObject[]) ?? []).map((x) => item(ctx, cache, x, i)));
    }
    case 'subitem:move':
      return [
        await send(
          ctx,
          'POST',
          `/items/${enc(param(ctx, 'itemId', i))}/reparent`,
          { parent_item_id: param(ctx, 'parentItemId', i), position: param(ctx, 'position', i, 'bottom') },
          i,
        ),
      ];
    // ── updates ────────────────────────────────────────────────────────────────────────────────────────────
    case 'update:create':
      return [
        await send(ctx, 'POST', `/items/${enc(param(ctx, 'itemId', i))}/updates`, { body: param(ctx, 'body', i) }, i),
      ];
    case 'update:reply':
      return [
        await send(
          ctx,
          'POST',
          `/updates/${enc(param(ctx, 'updateId', i))}/replies`,
          { body: param(ctx, 'body', i) },
          i,
        ),
      ];
    case 'update:tickTask':
      return [
        await send(
          ctx,
          'PUT',
          `/updates/${enc(param(ctx, 'updateId', i))}/tasks/${Math.max(0, param<number>(ctx, 'index', i, 1) - 1)}`,
          { checked: param<boolean>(ctx, 'checked', i, true) },
          i,
        ),
      ];
    // ── time tracking ──────────────────────────────────────────────────────────────────────────────────────
    case 'time:start':
    case 'time:stop': {
      const note = operation === 'start' ? param(ctx, 'note', i, '').trim() : '';
      return [
        await send(
          ctx,
          'POST',
          `/items/${enc(param(ctx, 'itemId', i))}/time/${operation}`,
          { column_id: param(ctx, 'columnId', i), ...(note ? { note } : {}) },
          i,
        ),
      ];
    }
    case 'time:addEntry': {
      const started = new Date(param(ctx, 'startedAt', i));
      if (Number.isNaN(started.getTime()))
        throw new NodeOperationError(ctx.getNode(), '"Started At" is not a date', { itemIndex: i });
      const note = param(ctx, 'note', i, '').trim();
      return [
        await send(
          ctx,
          'POST',
          `/items/${enc(param(ctx, 'itemId', i))}/time/entries`,
          {
            column_id: param(ctx, 'columnId', i),
            started_at: started.toISOString(),
            duration_s: Math.round(param<number>(ctx, 'minutes', i, 30) * 60),
            ...(note ? { note } : {}),
          },
          i,
        ),
      ];
    }
    case 'time:getEntries': {
      const res = await get(ctx, `/items/${enc(param(ctx, 'itemId', i))}/time/entries`, undefined, i);
      return (res.data as IDataObject[]) ?? [];
    }
    // ── files ──────────────────────────────────────────────────────────────────────────────────────────────
    case 'file:addLink': {
      const name = param(ctx, 'linkName', i, '').trim();
      return [
        await send(
          ctx,
          'POST',
          `/items/${enc(param(ctx, 'itemId', i))}/cells/${enc(param(ctx, 'columnId', i))}/links`,
          { url: param(ctx, 'url', i).trim(), ...(name ? { name } : {}) },
          i,
        ),
      ];
    }
    case 'file:upload': {
      const prop = param(ctx, 'binaryPropertyName', i, 'data');
      const binary = ctx.helpers.assertBinaryData(i, prop);
      const buffer = await ctx.helpers.getBinaryDataBuffer(i, prop);
      const presigned = await send(
        ctx,
        'POST',
        '/files/presign',
        {
          name: binary.fileName ?? 'file',
          size: buffer.length,
          mime: binary.mimeType || 'application/octet-stream',
        },
        i,
      );
      let url = presigned.upload_url as string;
      if (url.startsWith('/')) {
        const credentials = await ctx.getCredentials(CREDENTIAL_NAME);
        url = `${normalizeBaseUrl(String(credentials.baseUrl ?? ''))}${url}`;
      }
      // The presigned URL carries its own authorisation: a plain PUT, never the API token.
      await ctx.helpers.httpRequest({
        method: 'PUT',
        url,
        body: buffer,
        headers: { ...((presigned.headers as IDataObject) ?? {}) },
      });
      const fileId = presigned.file_id as string;
      const file = await send(ctx, 'POST', `/files/${enc(fileId)}/complete`, {}, i);
      await send(
        ctx,
        'POST',
        `/items/${enc(param(ctx, 'itemId', i))}/cells/${enc(param(ctx, 'columnId', i))}/files`,
        { file_ids: [fileId] },
        i,
      );
      return [file];
    }
    // ── groups, agents, users, boards ──────────────────────────────────────────────────────────────────────
    case 'group:create': {
      const boardId = param(ctx, 'boardId', i);
      cache.schemas.delete(boardId);
      return [await send(ctx, 'POST', `/boards/${enc(boardId)}/groups`, { title: param(ctx, 'title', i) }, i)];
    }
    case 'group:update': {
      const boardId = param(ctx, 'boardId', i);
      cache.schemas.delete(boardId);
      return [
        await send(
          ctx,
          'PATCH',
          `/boards/${enc(boardId)}/groups/${enc(param(ctx, 'groupId', i))}`,
          { title: param(ctx, 'title', i).trim() },
          i,
        ),
      ];
    }
    case 'group:delete': {
      const boardId = param(ctx, 'boardId', i);
      cache.schemas.delete(boardId);
      return [await send(ctx, 'DELETE', `/boards/${enc(boardId)}/groups/${enc(param(ctx, 'groupId', i))}`, {}, i)];
    }
    case 'column:create': {
      const boardId = param(ctx, 'boardId', i);
      cache.schemas.delete(boardId);
      const description = param(ctx, 'description', i, '').trim();
      return [
        await send(
          ctx,
          'POST',
          `/boards/${enc(boardId)}/columns`,
          {
            title: param(ctx, 'title', i),
            type: param(ctx, 'columnType', i, 'text'),
            ...(description ? { description } : {}),
          },
          i,
        ),
      ];
    }
    case 'search:search': {
      const q = param(ctx, 'q', i, '').trim();
      if (q.length < 2)
        throw new NodeOperationError(ctx.getNode(), 'Search needs at least 2 characters', { itemIndex: i });
      return [
        await get(ctx, '/search', { q, ...(param<boolean>(ctx, 'archived', i, false) ? { archived: '1' } : {}) }, i),
      ];
    }
    case 'user:getTeams':
      return ((await get(ctx, '/teams', undefined, i)).data as IDataObject[]) ?? [];
    case 'agent:run': {
      const o = param<IDataObject>(ctx, 'agentOptions', i, {});
      return [
        await send(
          ctx,
          'POST',
          `/agents/${enc(param(ctx, 'agentId', i))}/runs`,
          {
            prompt: param(ctx, 'prompt', i),
            ...(o.itemId ? { item_id: o.itemId } : {}),
            ...(o.dryRun ? { dry_run: true } : {}),
          },
          i,
        ),
      ];
    }
    case 'user:getAll':
    case 'board:getAll': {
      const q = param(ctx, 'q', i, '').trim();
      const qs: IDataObject = resource === 'user' ? { status: 'active' } : {};
      if (q) qs.q = q;
      const rows = ((await get(ctx, resource === 'user' ? '/users' : '/boards', qs, i)).data as IDataObject[]) ?? [];
      return param<boolean>(ctx, 'returnAll', i, false) ? rows : rows.slice(0, param<number>(ctx, 'limit', i, 50));
    }
    case 'board:getSchema':
      return [(await schemaOf(ctx, cache, param(ctx, 'boardId', i), i)) as unknown as IDataObject];
    case 'apiCall:call': {
      const method = param(ctx, 'method', i, 'GET') as IHttpRequestMethods;
      const path = `/${param(ctx, 'path', i)
        .replace(/^\/+/, '')
        .replace(/^api\/v1\//, '')}`;
      const qs = parseJson(ctx, 'query', i);
      const body = method === 'GET' ? undefined : parseJson(ctx, 'body', i);
      const res = (await apiRequest.call(ctx, method, path, body, qs, i)) as unknown;
      if (Array.isArray(res)) return res as IDataObject[];
      return [(res && typeof res === 'object' ? res : { result: res }) as IDataObject];
    }
    default:
      throw new NodeOperationError(ctx.getNode(), `Unsupported operation "${operation}" of "${resource}"`, {
        itemIndex: i,
      });
  }
};
