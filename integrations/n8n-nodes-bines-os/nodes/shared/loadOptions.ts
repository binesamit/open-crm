// SPDX-License-Identifier: MIT
import type {
  IDataObject,
  ILoadOptionsFunctions,
  INodeListSearchResult,
  INodePropertyOptions,
  ResourceMapperFields,
} from 'n8n-workflow';
import { isSubitemEvent } from './constants';
import { apiRequest } from './transport';
import {
  choiceOption,
  mapperFields,
  needsChoiceLoad,
  type BoardSchema,
  type ChoicePurpose,
  type ColumnChoice,
  type IntegrationColumn,
  type Member,
} from './values';

/**
 * Pickers that load from the instance: boards, groups, columns, labels, people, agents, column values, and the column
 * mapper. Subitem operations and subitem trigger events pick the parent board; their columns come from its sub-board.
 */

const param = (ctx: ILoadOptionsFunctions, name: string): string => {
  try {
    const v = ctx.getCurrentNodeParameter(name) ?? ctx.getNodeParameter(name, '');
    return typeof v === 'string' ? v : String(v ?? '');
  } catch {
    return '';
  }
};

/**
 * Works on subitems: the Subitem resource of the action node, a time-tracking operation with "On a Subitem", or a
 * subitem event of the trigger.
 */
const onSubitems = (ctx: ILoadOptionsFunctions) =>
  param(ctx, 'resource') === 'subitem' || param(ctx, 'onSubitem') === 'true' || isSubitemEvent(param(ctx, 'event'));

export async function boardSchemaOf(this: ILoadOptionsFunctions, boardId: string): Promise<BoardSchema | null> {
  if (!boardId || boardId.startsWith('=')) return null;
  return (await apiRequest.call(
    this,
    'GET',
    `/boards/${encodeURIComponent(boardId)}/schema`,
  )) as unknown as BoardSchema;
}

/** The columns the current operation works on: the board's, or its sub-board's for subitems. */
const columnsOf = async (ctx: ILoadOptionsFunctions): Promise<IntegrationColumn[]> => {
  const s = await boardSchemaOf.call(ctx, param(ctx, 'boardId'));
  return (onSubitems(ctx) ? s?.subitems?.columns : s?.columns) ?? [];
};

const columnOptions = (columns: IntegrationColumn[], keep: (c: IntegrationColumn) => boolean = () => true) =>
  columns.filter(keep).map((c) => ({ name: `${c.title} (${c.type})`, value: c.id, description: c.description ?? '' }));

export async function getBoards(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const res = await apiRequest.call(this, 'GET', '/boards');
  return ((res.data as IDataObject[]) ?? []).map((b) => ({
    name: `${b.name as string} · ${b.workspace_name as string}`,
    value: b.id as string,
  }));
}

const groupsOf = async (ctx: ILoadOptionsFunctions, boardParam: string) =>
  ((await boardSchemaOf.call(ctx, param(ctx, boardParam)))?.groups ?? []).map((g) => ({ name: g.title, value: g.id }));

export async function getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return groupsOf(this, 'boardId');
}

export async function getTargetGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return groupsOf(this, 'targetBoardId');
}

export async function getColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const columns = await columnsOf(this);
  return [
    { name: onSubitems(this) ? 'Name (subitem name)' : 'Name (item name)', value: 'name' },
    ...columnOptions(columns.filter((c) => c.type !== 'name')),
  ];
}

/** The sub-board's columns (the trigger's "Subitem Column Changed"); empty = any column. */
export async function getSubitemColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const s = await boardSchemaOf.call(this, param(this, 'boardId'));
  return [
    { name: '(Any Column)', value: '' },
    ...columnOptions((s?.subitems?.columns ?? []).filter((c) => c.type !== 'name')),
  ];
}

export async function getStatusColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return columnOptions(await columnsOf(this), (c) => c.type === 'status');
}

export async function getFileColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const s = await boardSchemaOf.call(this, param(this, 'boardId'));
  return columnOptions(s?.columns ?? [], (c) => c.value_model === 'files');
}

export async function getTimeColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return columnOptions(await columnsOf(this), (c) => c.type === 'time_tracking');
}

/** The chosen board's item templates (each makes an item with its subitems). */
export async function getItemTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const boardId = param(this, 'boardId');
  if (!boardId || boardId.startsWith('=')) return [];
  const res = await apiRequest.call(this, 'GET', `/boards/${encodeURIComponent(boardId)}/item-templates`);
  return ((res.data as IDataObject[]) ?? []).map((t) => ({
    name: t.name as string,
    value: t.id as string,
    description: (t.description as string | undefined) ?? '',
  }));
}

/** Labels of the chosen status column (`statusColumnId`), by text — the platform filters by label text. */
export async function getLabels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const col = (await columnsOf(this)).find((c) => c.id === param(this, 'statusColumnId'));
  return [{ name: '(Any Label)', value: '' }, ...(col?.options ?? []).map((o) => ({ name: o.label, value: o.label }))];
}

export async function getUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const res = await apiRequest.call(this, 'GET', '/users', undefined, { status: 'active' });
  return ((res.data as Member[]) ?? []).map((m) => ({ name: `${m.name} <${m.email}>`, value: m.user_id }));
}

export async function getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const res = await apiRequest.call(this, 'GET', '/agents');
  return ((res.data as IDataObject[]) ?? []).map((a) => ({ name: a.name as string, value: a.id as string }));
}

/** The values a column can hold (`GET /boards/{id}/columns/{col}/choices`), narrowed by `q`. */
export async function choicesOf(
  this: ILoadOptionsFunctions,
  boardId: string,
  columnId: string,
  subitems: boolean,
  q = '',
): Promise<ColumnChoice[]> {
  if (!boardId || !columnId || boardId.startsWith('=') || columnId.startsWith('=')) return [];
  const res = await apiRequest.call(
    this,
    'GET',
    `/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}/choices`,
    undefined,
    { q, subitems: subitems ? 'true' : 'false' },
  );
  return (res.data as ColumnChoice[] | undefined) ?? [];
}

/** The column of the field being edited: a filter condition's own column (`&columnId`), else the node's. */
const currentColumn = (ctx: ILoadOptionsFunctions) => param(ctx, '&columnId') || param(ctx, 'columnId');

const searchValues = async (
  ctx: ILoadOptionsFunctions,
  purpose: ChoicePurpose,
  filter?: string,
): Promise<INodeListSearchResult> => {
  const choices = await choicesOf.call(ctx, param(ctx, 'boardId'), currentColumn(ctx), onSubitems(ctx), filter ?? '');
  return { results: choices.map((c) => choiceOption(c, purpose)) };
};

/** "Find by column value": the column's values as the find compares them (label, person or item name, text). */
export async function searchFindValues(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
  return searchValues(this, 'find', filter);
}

/** A filter condition: label text, user id, tag id or item id — what the query takes. */
export async function searchFilterValues(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
  return searchValues(this, 'filter', filter);
}

const fields = async (
  ctx: ILoadOptionsFunctions,
  schema: BoardSchema | null,
  subitems: boolean,
): Promise<ResourceMapperFields> => {
  const columns = (subitems ? schema?.subitems?.columns : schema?.columns) ?? [];
  const choices: Record<string, ColumnChoice[]> = {};
  await Promise.all(
    columns.filter(needsChoiceLoad).map(async (c) => {
      choices[c.id] = await choicesOf.call(ctx, schema!.id, c.id, subitems).catch(() => []);
    }),
  );
  return {
    fields: mapperFields(columns, choices),
    emptyFieldsNotice:
      subitems && schema && !schema.subitems
        ? 'This board has no subitems yet — add the first subitem (here or in the app) and its columns show here'
        : 'Choose a board first — its columns show here, each in the right type',
  };
};

/** The column mapper of a board's items. */
export async function getColumnFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
  return fields(this, await boardSchemaOf.call(this, param(this, 'boardId')), false);
}

/** The column mapper of a board's subitems (its sub-board). */
export async function getSubitemColumnFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
  return fields(this, await boardSchemaOf.call(this, param(this, 'boardId')), true);
}
