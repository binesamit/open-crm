// SPDX-License-Identifier: MIT
/**
 * The "Bines OS" Make custom app, as data. `build.ts` writes it to `app/` (one JSON file per Make section), the push
 * script uploads `app/` with Make's SDK-apps API, and the tests validate it. Nothing here knows a specific account,
 * board or column: every board, group, column, label, person and agent is loaded from the connected instance.
 *
 * Make's terms: a module's `parameters` are its static parameters, `expect` its mappable ones, `interface` its output;
 * `rpc://name` loads options or fields from an RPC; `{{…}}` is IML.
 *
 * No custom IML functions: Make enables them only through a support ticket. Every expression uses Make's built-in
 * functions and operators only (the tests refuse any other function name); whatever plain IML cannot express is done
 * by the Bines OS API — `values` (plain column values converted on the server), `?format=flat` (items with
 * `column_values` by title), `GET /boards/{id}/fields` (the column-values form), flat query `rules`, a move without a
 * mapping, and `flat` webhook subscriptions (`deliveryId` and `item.column_values` in the event).
 */

/** Every product-facing name comes from here (the app's internal `name` is what scenarios store — never rename). */
export const PRODUCT_NAME = 'Bines OS';
export const APP_NAME = 'bines-os';
export const CONNECTION = 'binesOs';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** Make module types (SDK API `typeId`). */
export const MODULE_TYPE = { action: 4, search: 9, instant: 10, universal: 12 } as const;
export type ModuleKind = keyof typeof MODULE_TYPE;

export type ModuleSpec = {
  kind: ModuleKind;
  label: string;
  description: string;
  /** Local webhook key (instant triggers). */
  webhook?: string;
  api?: Json;
  parameters?: Json[];
  expect?: Json[];
  interface: Json[];
  samples?: Obj;
};
export type WebhookSpec = { label: string; api: Obj; parameters: Json[]; attach: Obj; detach: Obj };
export type RpcSpec = { label: string; api: Obj; parameters: Json[] };

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────────────────────

const auth = { Authorization: 'Bearer {{connection.apiToken}}' };

/** Trailing slashes, then a typed `/api/v1` (regular expressions in Make's `replace`; `[/]` avoids escapes). */
export const TRAILING_SLASHES = '/[/]+$/';
export const API_SUFFIX = '/[/]api[/]v1$/';
/** IML: the instance's origin from the address a person typed (with or without /api/v1, trailing slashes). */
const originOf = (v: string) => `replace(replace(trim(${v}), '${TRAILING_SLASHES}', ''), '${API_SUFFIX}', '')`;
/** `https://crm.example.com/api/v1` from the connection's address. */
const apiBase = (v: string) => `{{${originOf(v)}}}/api/v1`;

/** Items answer with `column_values` (each cell's text by column title) — `?format=flat`. */
const flat = { format: 'flat' };

export const base: Obj = {
  baseUrl: apiBase('connection.baseUrl'),
  headers: auth,
  response: {
    error: {
      type: 'RuntimeError',
      message: '[{{statusCode}}] {{ifempty(body.error.message, body)}} ({{body.error.code}})',
      '401': { type: 'InvalidAccessTokenError', message: '[401] {{ifempty(body.error.message, "Invalid API token")}}' },
      '403': { type: 'InvalidConfigurationError', message: '[403] {{body.error.message}} ({{body.error.code}})' },
      '404': { type: 'DataError', message: '[404] {{ifempty(body.error.message, "Not found")}}' },
      '409': { type: 'DataError', message: '[409] {{body.error.message}} ({{body.error.code}})' },
      '422': { type: 'DataError', message: '[422] {{body.error.message}} ({{body.error.code}})' },
      '423': { type: 'InvalidConfigurationError', message: '[423] {{body.error.message}}' },
      '429': { type: 'RateLimitError', message: '[429] {{ifempty(body.error.message, "Rate limit")}}' },
      '503': { type: 'ConnectionError', message: '[503] {{ifempty(body.error.message, "Service unavailable")}}' },
    },
  },
  log: { sanitize: ['request.headers.authorization'] },
};

export const connection = {
  label: PRODUCT_NAME,
  type: 'apikey',
  parameters: [
    {
      name: 'baseUrl',
      label: 'Instance URL',
      type: 'url',
      required: true,
      help: `The address you open ${PRODUCT_NAME} at, e.g. https://crm.example.com (with or without /api/v1).`,
    },
    {
      name: 'apiToken',
      label: 'API token',
      type: 'password',
      required: true,
      help: `A personal API token (bos_pat_…) from ${PRODUCT_NAME} → profile menu → API tokens. Give it the scopes your scenarios need: boards:read, items:write, updates:write, webhooks (instant triggers), users:read, boards:write (groups), agents:run (AI agents).`,
    },
  ] as Json[],
  api: {
    url: `${apiBase('parameters.baseUrl')}/auth/me`,
    headers: { Authorization: 'Bearer {{parameters.apiToken}}' },
    response: {
      metadata: { type: 'email', value: '{{body.user.email}}' },
      error: { message: '[{{statusCode}}] {{ifempty(body.error.message, "Cannot sign in with this token")}}' },
    },
    log: { sanitize: ['request.headers.authorization'] },
  } as Obj,
};

// ── RPCs (pickers and dynamic fields) ──────────────────────────────────────────────────────────────────────────

const schemaUrl = '/boards/{{parameters.boardId}}/schema';
/** The `subitems` query flag of the API (`true` / `false`) from the RPC's boolean parameter. */
const subitemsFlag = "{{if(parameters.subitems, 'true', 'false')}}";
const options = (iterate: Json, label: string, value: string) => ({
  iterate,
  output: { label, value },
});

export const rpcs: Record<string, RpcSpec> = {
  listBoards: {
    label: 'List boards',
    parameters: [],
    api: { url: '/boards', response: options('{{body.data}}', '{{item.name}}', '{{item.id}}') },
  },
  listGroups: {
    label: 'List groups',
    parameters: [{ name: 'boardId', type: 'text', label: 'Board', required: true }],
    api: { url: schemaUrl, response: options('{{body.groups}}', '{{item.title}}', '{{item.id}}') },
  },
  listColumns: {
    label: 'List columns',
    parameters: [
      { name: 'boardId', type: 'text', label: 'Board', required: true },
      { name: 'kind', type: 'text', label: 'Column type (status, files, …)' },
      { name: 'subitems', type: 'boolean', label: 'Subitem columns (the sub-board)' },
    ],
    api: {
      url: schemaUrl,
      response: options(
        {
          // The board's columns or its sub-board's; `kind` keeps one type (`files`: every files column).
          container: '{{if(parameters.subitems, body.subitems.columns, body.columns)}}',
          condition:
            "{{if(parameters.kind, if(parameters.kind == 'files', item.value_model == 'files', item.type == parameters.kind), true)}}",
        },
        '{{item.title}} ({{item.type}})',
        '{{item.id}}',
      ),
    },
  },
  listLabels: {
    label: 'List status labels',
    parameters: [
      { name: 'boardId', type: 'text', label: 'Board', required: true },
      { name: 'columnId', type: 'text', label: 'Status column', required: true },
      { name: 'subitems', type: 'boolean', label: 'Subitem columns (the sub-board)' },
    ],
    api: {
      // The column's labels; a status subscription narrows by the label's text.
      url: '/boards/{{parameters.boardId}}/columns/{{parameters.columnId}}/choices',
      qs: { subitems: subitemsFlag },
      response: options('{{body.data}}', '{{item.text}}', '{{item.text}}'),
    },
  },
  listValues: {
    label: 'List the values of a column',
    parameters: [
      { name: 'boardId', type: 'text', label: 'Board', required: true },
      { name: 'column_id', type: 'text', label: 'Column', required: true },
      { name: 'subitems', type: 'boolean', label: 'Subitem columns (the sub-board)' },
      { name: 'purpose', type: 'text', label: 'write, find or filter' },
    ],
    api: {
      url: '/boards/{{parameters.boardId}}/columns/{{parameters.column_id}}/choices',
      qs: { subitems: subitemsFlag },
      // "Dana Levi (dana@example.com)"; find compares the text, a write or a filter takes the id.
      response: options(
        '{{body.data}}',
        "{{item.text}}{{if(item.hint, ' (' + item.hint + ')', '')}}",
        "{{if(parameters.purpose == 'find', item.text, ifempty(item.id, item.text))}}",
      ),
    },
  },
  listUsers: {
    label: 'List users',
    parameters: [],
    api: {
      url: '/users',
      qs: { status: 'active' },
      response: options('{{body.data}}', '{{item.name}} <{{item.email}}>', '{{item.user_id}}'),
    },
  },
  listAgents: {
    label: 'List AI agents',
    parameters: [],
    api: { url: '/agents', response: options('{{body.data}}', '{{item.name}}', '{{item.id}}') },
  },
  listItemTemplates: {
    label: 'List item templates',
    parameters: [{ name: 'boardId', type: 'text', label: 'Board', required: true }],
    api: {
      url: '/boards/{{parameters.boardId}}/item-templates',
      response: options('{{body.data}}', '{{item.name}}', '{{item.id}}'),
    },
  },
  columnFields: {
    label: 'Column value fields',
    parameters: [
      { name: 'boardId', type: 'text', label: 'Board', required: true },
      { name: 'subitems', type: 'boolean', label: 'Subitem columns' },
    ],
    api: {
      // The server renders each writable column as a field in its type (`GET /boards/{id}/fields`).
      url: '/boards/{{parameters.boardId}}/fields',
      qs: { subitems: subitemsFlag },
      response: { output: { name: 'columns', label: 'Column values', type: 'collection', spec: '{{body.data}}' } },
    },
  },
};

// ── parameters ─────────────────────────────────────────────────────────────────────────────────────────────────

const board = (nested: Json[] = [], label = 'Board', name = 'boardId'): Obj => ({
  name,
  label,
  type: 'select',
  required: true,
  options: { store: 'rpc://listBoards', nested },
});
const group = (required = false): Obj => ({
  name: 'groupId',
  label: 'Group',
  type: 'select',
  required,
  options: 'rpc://listGroups',
});
const text = (name: string, label: string, extra: Obj = {}): Obj => ({ name, label, type: 'text', ...extra });
const itemId = (label = 'Item ID'): Obj => text('itemId', label, { required: true });
/**
 * A value picked from the column (labels, people, tags, connected items, values already used). Its name is the
 * API's (`choice` of a query rule), and the column's is `column_id` — the name `listValues` reads it by.
 */
const valueChoice = (purpose: 'find' | 'filter', subitems = false): Obj => ({
  name: 'choice',
  label: 'Value (pick)',
  type: 'select',
  help: 'Pick one of the column values — or leave empty and type the value below.',
  options: `rpc://listValues?purpose=${purpose}${subitems ? '&subitems=true' : ''}`,
});
/** A column select with the value picker under it. */
const columnWithValue = (purpose: 'find' | 'filter', subitems = false): Obj => ({
  name: 'column_id',
  label: 'Column',
  type: 'select',
  required: true,
  options: {
    store: `rpc://listColumns${subitems ? '?subitems=true' : ''}`,
    nested: [valueChoice(purpose, subitems)],
  },
});
const filtersParam = (subitems = false): Obj => ({
  name: 'filters',
  label: 'Filters',
  type: 'array',
  help: 'All conditions must match.',
  spec: [
    columnWithValue('filter', subitems),
    {
      name: 'operator',
      label: 'Operator',
      type: 'select',
      default: 'any_of',
      options: [
        { label: 'Is (any of)', value: 'any_of' },
        { label: 'Is not (none of)', value: 'not_any_of' },
        { label: 'Contains text', value: 'contains_text' },
        { label: 'Greater than', value: 'greater_than' },
        { label: 'Lower than', value: 'lower_than' },
        { label: 'Is empty', value: 'is_empty' },
        { label: 'Is not empty', value: 'is_not_empty' },
      ],
    },
    text('value', 'Value', {
      help: 'Used when nothing is picked above. For "any of": values separated by commas (labels by text, people / tags / items by ID).',
    }),
  ],
});
const findParams = (subitems = false): Json[] => [
  board([columnWithValue('find', subitems)], subitems ? 'Board of the parent items' : 'Board'),
  text('value', 'Value', { help: 'Used when nothing is picked above.' }),
  {
    name: 'match',
    label: 'Match',
    type: 'select',
    default: 'exact',
    options: [
      { label: 'Exact', value: 'exact' },
      { label: 'Contains', value: 'contains' },
    ],
  },
  limit(10),
];
const findBody = {
  column_id: '{{parameters.column_id}}',
  value: '{{ifempty(parameters.choice, parameters.value)}}',
  match: '{{parameters.match}}',
  limit: '{{parameters.limit}}',
};

const limit = (def: number): Obj => ({
  name: 'limit',
  label: 'Limit',
  type: 'uinteger',
  default: def,
  help: 'The most results this module returns in one run.',
});

// ── output interfaces ──────────────────────────────────────────────────────────────────────────────────────────

const cellsField = { name: 'cells', label: 'Cells (stored values by column id)', type: 'any' };
const columnValuesField = { name: 'column_values', label: 'Column values (text)', type: 'any' };
const itemInterface: Json[] = [
  { name: 'id', label: 'Item ID', type: 'text' },
  { name: 'name', label: 'Name', type: 'text' },
  { name: 'board_id', label: 'Board ID', type: 'text' },
  { name: 'group_id', label: 'Group ID', type: 'text' },
  { name: 'parent_item_id', label: 'Parent item ID', type: 'text' },
  { name: 'key', label: 'Key', type: 'text' },
  columnValuesField,
  cellsField,
  { name: 'created_at', label: 'Created at', type: 'date' },
  { name: 'updated_at', label: 'Updated at', type: 'date' },
];
const itemSample: Obj = {
  id: '01JBITEM0000000000000000',
  name: 'Dana Levi',
  board_id: '01JBBOARD000000000000000',
  group_id: 'topics',
  parent_item_id: null,
  key: null,
  column_values: { Status: 'Done', Phone: '050-1234567' },
  cells: {
    status: { value: { index: 1 }, text: 'Done' },
    phone: { value: { phone: '050-1234567' }, text: '050-1234567' },
  },
  created_at: '2026-10-06T09:30:00.000Z',
  updated_at: '2026-10-06T09:30:00.000Z',
};
const okInterface: Json[] = [{ name: 'ok', label: 'OK', type: 'boolean' }];

// ── instant triggers (one dedicated, attached webhook each) ────────────────────────────────────────────────────

type TriggerDef = {
  event: string;
  key: string;
  label: string;
  description: string;
  /** Extra webhook parameters, nested under the board. */
  nested?: Json[];
  /** Extra output fields. */
  fields?: Json[];
  sample?: Obj;
};

const columnFields: Json[] = [
  { name: 'columnId', label: 'Column ID', type: 'text' },
  { name: 'columnType', label: 'Column type', type: 'text' },
  { name: 'columnTitle', label: 'Column title', type: 'text' },
  { name: 'value', label: 'Value', type: 'any' },
  { name: 'previousValue', label: 'Previous value', type: 'any' },
];
const columnSample: Obj = {
  columnId: 'status',
  columnType: 'status',
  columnTitle: 'Status',
  value: { index: 1, text: 'Done' },
  previousValue: { index: 0, text: 'New' },
};

export const TRIGGERS: TriggerDef[] = [
  {
    event: 'item_created',
    key: 'watchItemsCreated',
    label: 'Watch Items Created',
    description: 'An item was added to the board.',
  },
  {
    event: 'specific_column_changed',
    key: 'watchColumnValueChanged',
    label: 'Watch Column Value Changed',
    description: 'A value of the chosen column changed.',
    nested: [{ name: 'columnId', label: 'Column', type: 'select', required: true, options: 'rpc://listColumns' }],
    fields: columnFields,
    sample: columnSample,
  },
  {
    event: 'status_changed',
    key: 'watchStatusChanged',
    label: 'Watch Status Changed',
    description: 'A status column changed — optionally only one column, or only to one label.',
    nested: [
      {
        name: 'columnId',
        label: 'Status column',
        type: 'select',
        help: 'Leave empty for any status column.',
        options: {
          store: 'rpc://listColumns?kind=status',
          nested: [
            {
              name: 'label',
              label: 'Label',
              type: 'select',
              help: 'Only when the status becomes this label. Leave empty for any label.',
              options: 'rpc://listLabels',
            },
          ],
        },
      },
    ],
    fields: columnFields,
    sample: columnSample,
  },
  {
    event: 'column_changed',
    key: 'watchAnyColumnChanged',
    label: 'Watch Any Column Changed',
    description: 'Any value of the board changed.',
    fields: columnFields,
    sample: columnSample,
  },
  {
    event: 'item_name_changed',
    key: 'watchItemsRenamed',
    label: 'Watch Items Renamed',
    description: 'An item got a new name.',
  },
  {
    event: 'update_created',
    key: 'watchUpdates',
    label: 'Watch Updates',
    description: 'An update (comment) was posted on an item.',
    fields: [{ name: 'updateId', label: 'Update ID', type: 'text' }],
    sample: { updateId: '01JBUPDATE00000000000000' },
  },
  {
    event: 'item_moved_to_specific_group',
    key: 'watchItemsMovedToGroup',
    label: 'Watch Items Moved to a Group',
    description: 'An item moved into the chosen group.',
    nested: [group(true)],
    fields: [
      { name: 'sourceGroupId', label: 'From group ID', type: 'text' },
      { name: 'destGroupId', label: 'To group ID', type: 'text' },
    ],
  },
  {
    event: 'item_moved_to_group',
    key: 'watchItemsMovedToAnyGroup',
    label: 'Watch Items Moved to Any Group',
    description: 'An item moved between groups.',
    fields: [
      { name: 'sourceGroupId', label: 'From group ID', type: 'text' },
      { name: 'destGroupId', label: 'To group ID', type: 'text' },
    ],
  },
  {
    event: 'item_archived',
    key: 'watchItemsArchived',
    label: 'Watch Archived Items',
    description: 'An item was archived.',
  },
  {
    event: 'item_deleted',
    key: 'watchItemsDeleted',
    label: 'Watch Deleted Items',
    description: 'An item was moved to the trash.',
  },
  // 0.3: the newer platform events, as in the n8n trigger.
  {
    event: 'item_restored',
    key: 'watchItemsRestored',
    label: 'Watch Restored Items',
    description: 'An item came back from the trash or the archive.',
  },
  {
    event: 'item_moved_to_board',
    key: 'watchItemsMovedToBoard',
    label: 'Watch Items Moved to This Board',
    description: 'An item moved here from another board.',
  },
  {
    event: 'update_edited',
    key: 'watchUpdatesEdited',
    label: 'Watch Edited Updates',
    description: 'An update (comment) on an item was edited.',
    fields: [{ name: 'updateId', label: 'Update ID', type: 'text' }],
    sample: { updateId: '01JBUPDATE00000000000000' },
  },
  {
    event: 'update_deleted',
    key: 'watchUpdatesDeleted',
    label: 'Watch Deleted Updates',
    description: 'An update (comment) on an item was deleted.',
    fields: [{ name: 'updateId', label: 'Update ID', type: 'text' }],
    sample: { updateId: '01JBUPDATE00000000000000' },
  },
  {
    event: 'file_added',
    key: 'watchFilesAdded',
    label: 'Watch Files Added',
    description: 'A file was added to a files column or an update.',
    fields: [
      {
        name: 'files',
        label: 'Files',
        type: 'array',
        spec: [
          { name: 'id', label: 'File ID', type: 'text' },
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'size', label: 'Size', type: 'number' },
          { name: 'mime', label: 'Type', type: 'text' },
        ],
      },
    ],
    sample: { files: [{ id: '01JBFILE0000000000000000', name: 'brief.pdf', size: 52000, mime: 'application/pdf' }] },
  },
  {
    event: 'group_created',
    key: 'watchGroupsCreated',
    label: 'Watch Groups Created',
    description: 'A group was added to the board.',
  },
  {
    event: 'column_created',
    key: 'watchColumnsCreated',
    label: 'Watch Columns Created',
    description: 'A column was added to the board.',
    fields: [
      { name: 'columnId', label: 'Column ID', type: 'text' },
      { name: 'columnType', label: 'Column type', type: 'text' },
      { name: 'columnTitle', label: 'Column title', type: 'text' },
    ],
    sample: { columnId: 'budget', columnType: 'numbers', columnTitle: 'Budget' },
  },
  {
    event: 'column_type_changed',
    key: 'watchColumnTypeChanged',
    label: 'Watch Column Type Changed',
    description: "A column's type was changed.",
    fields: [
      { name: 'columnId', label: 'Column ID', type: 'text' },
      { name: 'columnType', label: 'Column type', type: 'text' },
      { name: 'columnTitle', label: 'Column title', type: 'text' },
      { name: 'previousColumnType', label: 'Previous type', type: 'text' },
      { name: 'conversionId', label: 'Conversion ID', type: 'text' },
    ],
    sample: {
      columnId: 'budget',
      columnType: 'numbers',
      columnTitle: 'Budget',
      previousColumnType: 'text',
      conversionId: '01JBCONVERSION0000000000',
    },
  },
  {
    event: 'subitem_created',
    key: 'watchSubitemsCreated',
    label: 'Watch Subitems Created',
    description: 'A subitem was added under an item.',
  },
  {
    event: 'subitem_column_changed',
    key: 'watchSubitemColumnChanged',
    label: 'Watch Subitem Column Changed',
    description: 'A value of a subitem changed — optionally only one subitem column.',
    nested: [
      {
        name: 'columnId',
        label: 'Subitem column',
        type: 'select',
        help: 'Leave empty for any column of the subitems.',
        options: 'rpc://listColumns?subitems=true',
      },
    ],
    fields: columnFields,
    sample: columnSample,
  },
  {
    event: 'subitem_status_changed',
    key: 'watchSubitemStatusChanged',
    label: 'Watch Subitem Status Changed',
    description: 'A status column of a subitem changed — optionally only one column, or only to one label.',
    nested: [
      {
        name: 'columnId',
        label: 'Subitem status column',
        type: 'select',
        help: 'Leave empty for any status column of the subitems.',
        options: {
          store: 'rpc://listColumns?kind=status&subitems=true',
          nested: [
            {
              name: 'label',
              label: 'Label',
              type: 'select',
              help: 'Only when the status becomes this label. Leave empty for any label.',
              options: 'rpc://listLabels?subitems=true',
            },
          ],
        },
      },
    ],
    fields: columnFields,
    sample: columnSample,
  },
  {
    event: 'subitem_name_changed',
    key: 'watchSubitemsRenamed',
    label: 'Watch Subitems Renamed',
    description: 'A subitem got a new name.',
  },
  {
    event: 'subitem_archived',
    key: 'watchSubitemsArchived',
    label: 'Watch Archived Subitems',
    description: 'A subitem was archived.',
  },
  {
    event: 'subitem_deleted',
    key: 'watchSubitemsDeleted',
    label: 'Watch Deleted Subitems',
    description: 'A subitem was moved to the trash.',
  },
  {
    event: 'subitem_update_created',
    key: 'watchSubitemUpdates',
    label: 'Watch Subitem Updates',
    description: 'An update (comment) was posted on a subitem.',
    fields: [{ name: 'updateId', label: 'Update ID', type: 'text' }],
    sample: { updateId: '01JBUPDATE00000000000000' },
  },
  {
    event: 'automation_sent',
    key: 'watchAutomationSends',
    label: 'Watch "Send to Integrations"',
    description: `A ${PRODUCT_NAME} automation ran its "send to integrations" action (any trigger, any conditions).`,
    nested: [
      text('channel', 'Channel', {
        help: 'Optional. Only actions sent on this channel (free text, e.g. new-lead) — several scenarios can listen to different automations of one board.',
      }),
    ],
    fields: [
      { name: 'channel', label: 'Channel', type: 'text' },
      { name: 'automationId', label: 'Automation ID', type: 'text' },
    ],
    sample: { channel: 'new-lead', automationId: '01JBAUTOMATION0000000000' },
  },
];

/** Trigger options that narrow another platform event. */
const API_EVENT: Record<string, string> = { subitem_status_changed: 'subitem_column_changed' };

/** Events whose subscription narrows by column / by status label. */
const COLUMN_EVENTS = ['specific_column_changed', 'status_changed', 'subitem_column_changed', 'subitem_status_changed'];
const LABEL_EVENTS = ['status_changed', 'subitem_status_changed'];

/**
 * The subscription a trigger makes when its scenario is turned on (`POST /boards/{id}/webhooks`): the event, the
 * options the person chose (empty = not narrowed) and `format: flat` — the event then carries `deliveryId` and the
 * item's `column_values`, so the trigger outputs it as is.
 */
export const hookBody = (t: Pick<TriggerDef, 'event'>): Obj => {
  const config: Obj = { include_item: '{{parameters.includeItem != false}}', format: 'flat' };
  if (COLUMN_EVENTS.includes(t.event)) config.column_id = "{{ifempty(parameters.columnId, '')}}";
  if (t.event === 'subitem_status_changed') config.column_type = 'status';
  if (LABEL_EVENTS.includes(t.event)) config.label = "{{ifempty(parameters.label, '')}}";
  if (t.event === 'item_moved_to_specific_group') config.group_id = '{{parameters.groupId}}';
  if (t.event === 'automation_sent') config.channel = "{{trim(ifempty(parameters.channel, ''))}}";
  return { url: '{{webhook.url}}', event: API_EVENT[t.event] ?? t.event, config, description: `Make: ${t.event}` };
};

/** A delivery's header (Make may keep the sender's casing). */
const header = (name: string) =>
  `ifempty(get(headers, '${name}'), get(headers, '${name.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase())}'))`;
/** A delivery's value: the header, else the same value in the (flat) body — Make may not pass the headers on. */
const fromDelivery = (name: string, inBody: string) => `ifempty(${header(name)}, ${inBody})`;
const timestamp = fromDelivery('x-bines-timestamp', 'body.timestamp');
const deliveryId = fromDelivery('x-bines-delivery', 'body.event.deliveryId');
const signatureLite = fromDelivery('x-bines-signature-lite', 'body.signatureLite');
/** The webhook's secret, kept from the subscription's answer (`attach` → `response.data.secret`). */
const secret = 'ifempty(parameters.secret, webhook.secret)';
/**
 * The signature check, in built-in IML: the lite signature (`X-Bines-Signature-Lite`, or `signatureLite` in a flat
 * body) must be `sha256=` + HMAC-SHA256(secret, timestamp + "." + deliveryId), and the timestamp at most 10 minutes
 * old. The lite signature never re-serialises the body: `createJSON(body)` is not the bytes Bines OS signed (key order,
 * Hebrew / Unicode escaping, number formats), so the full-body `X-Bines-Signature` cannot be checked here. Replay is
 * bounded by the window and the unique delivery id. Switched off per webhook with *Verify signature*.
 */
export const VERIFY_CONDITION =
  `{{if(parameters.verifySignature == false, true, ` +
  `${secret} && ${timestamp} && ${deliveryId} && ` +
  `abs(parseNumber(formatDate(now, 'x')) - parseNumber(${timestamp})) <= 600000 && ` +
  `${signatureLite} == 'sha256=' + sha256(${timestamp} + '.' + ${deliveryId}, 'hex', ${secret}))}}`;

const eventInterface = (extra: Json[] = []): Json[] => [
  { name: 'type', label: 'Event', type: 'text' },
  { name: 'boardId', label: 'Board ID', type: 'text' },
  { name: 'boardName', label: 'Board name', type: 'text' },
  { name: 'groupId', label: 'Group ID', type: 'text' },
  { name: 'groupName', label: 'Group name', type: 'text' },
  { name: 'itemId', label: 'Item ID', type: 'text' },
  { name: 'itemName', label: 'Item name', type: 'text' },
  { name: 'parentItemId', label: 'Parent item ID', type: 'text' },
  ...extra,
  {
    name: 'actor',
    label: 'Done by',
    type: 'collection',
    spec: [
      { name: 'kind', label: 'Kind', type: 'text' },
      { name: 'id', label: 'ID', type: 'text' },
      { name: 'name', label: 'Name', type: 'text' },
    ],
  },
  { name: 'item', label: 'Item', type: 'collection', spec: itemInterface },
  { name: 'triggerTime', label: 'Time', type: 'date' },
  { name: 'eventId', label: 'Event ID', type: 'text' },
  { name: 'subscriptionId', label: 'Subscription ID', type: 'text' },
  { name: 'deliveryId', label: 'Delivery ID', type: 'text' },
];

const hookParameters = (nested: Json[] = []): Json[] => [
  board(nested),
  {
    name: 'includeItem',
    label: 'Include the item',
    type: 'boolean',
    default: true,
    advanced: true,
    help: 'Each event carries the item with its column values (no second call needed).',
  },
  {
    name: 'verifySignature',
    label: 'Verify signature',
    type: 'boolean',
    default: true,
    advanced: true,
    help: `Accept only deliveries signed by ${PRODUCT_NAME} with this webhook's secret (HMAC-SHA256).`,
  },
];

export const webhooks: Record<string, WebhookSpec> = Object.fromEntries(
  TRIGGERS.map((t): [string, WebhookSpec] => [
    t.key,
    {
      label: `${PRODUCT_NAME}: ${t.label.replace(/^Watch /, '')}`,
      parameters: hookParameters(t.nested),
      api: {
        verification: {
          condition: '{{if(body.challenge, true, false)}}',
          respond: { status: 200, type: 'json', body: { challenge: '{{body.challenge}}' } },
        },
        condition: VERIFY_CONDITION,
        respond: { status: 200, type: 'json', body: { ok: true } },
        // A `flat` subscription: the event already carries `deliveryId` and the item's `column_values`.
        output: '{{body.event}}',
      },
      attach: {
        url: `${apiBase('connection.baseUrl')}/boards/{{parameters.boardId}}/webhooks`,
        method: 'POST',
        headers: auth,
        body: hookBody(t),
        response: { data: { externalHookId: '{{body.id}}', secret: '{{body.secret}}' } },
        log: { sanitize: ['request.headers.authorization', 'response.body.secret'] },
      },
      detach: {
        url: `${apiBase('connection.baseUrl')}/webhooks/{{webhook.externalHookId}}`,
        method: 'DELETE',
        headers: auth,
        log: { sanitize: ['request.headers.authorization'] },
      },
    },
  ]),
);

const triggerModules: Record<string, ModuleSpec> = Object.fromEntries(
  TRIGGERS.map((t): [string, ModuleSpec] => [
    t.key,
    {
      kind: 'instant',
      label: t.label,
      description: t.description,
      webhook: t.key,
      parameters: [],
      expect: [],
      interface: eventInterface(t.fields),
      samples: {
        type: API_EVENT[t.event] ?? t.event,
        boardId: '01JBBOARD000000000000000',
        boardName: 'Leads',
        groupId: 'topics',
        groupName: 'New',
        itemId: itemSample.id as string,
        itemName: itemSample.name as string,
        parentItemId: null,
        ...(t.sample ?? {}),
        actor: { kind: 'user', id: '01JBUSER0000000000000000', name: 'Dana' },
        item: itemSample,
        triggerTime: '2026-10-06T09:30:00.000Z',
        eventId: '01JBEVENT000000000000000',
        subscriptionId: '01JBHOOK0000000000000000',
        deliveryId: '01JBDELIVERY000000000000',
      },
    },
  ]),
);

// ── actions, searches, universal ───────────────────────────────────────────────────────────────────────────────

/**
 * The column values form as the API's `values`: plain input (a status by label, people by email or name, dates …)
 * that the server converts per column type — an unknown label or person stops the module with the choices.
 */
const values = '{{parameters.columns}}';
const out = (output: string): Obj => ({ response: { output } });

/** A board and its timer column (for a subitem's timer, map the sub-board column's ID). */
const timerColumn = (): Obj =>
  board([
    {
      name: 'columnId',
      label: 'Timer column',
      type: 'select',
      required: true,
      options: 'rpc://listColumns?kind=time_tracking',
      help: 'For a subitem, choose its parent board and map the subitem timer column’s ID.',
    },
  ]);
const timeEntryInterface: Json[] = [
  { name: 'id', label: 'Entry ID', type: 'text' },
  { name: 'item_id', label: 'Item ID', type: 'text' },
  { name: 'column_id', label: 'Column ID', type: 'text' },
  { name: 'started_at', label: 'Started at', type: 'date' },
  { name: 'ended_at', label: 'Ended at', type: 'date' },
  { name: 'duration_s', label: 'Seconds', type: 'number' },
  { name: 'note', label: 'Note', type: 'text' },
];

const actionModules: Record<string, ModuleSpec> = {
  createItem: {
    kind: 'action',
    label: 'Create an Item',
    description: 'Creates an item with column values.',
    expect: [board([group(), 'rpc://columnFields']), text('name', 'Name', { required: true })],
    api: {
      url: '/boards/{{parameters.boardId}}/items',
      method: 'POST',
      qs: flat,
      body: { name: '{{parameters.name}}', group_id: '{{parameters.groupId}}', values },
      ...out('{{body}}'),
    },
    interface: itemInterface,
    samples: itemSample,
  },
  updateItem: {
    kind: 'action',
    label: 'Update an Item',
    description: 'Changes an item’s name and column values. Empty fields leave the column unchanged.',
    expect: [
      board(['rpc://columnFields'], 'Board', 'boardId'),
      itemId(),
      text('name', 'New name', { help: 'Leave empty to keep the name.' }),
    ],
    api: {
      url: '/items/{{parameters.itemId}}',
      method: 'PATCH',
      qs: flat,
      body: { name: '{{parameters.name}}', values },
      ...out('{{body}}'),
    },
    interface: itemInterface,
    samples: itemSample,
  },
  getItem: {
    kind: 'action',
    label: 'Get an Item',
    description: 'Returns an item with its column values.',
    expect: [itemId()],
    api: { url: '/items/{{parameters.itemId}}', qs: flat, ...out('{{body}}') },
    interface: itemInterface,
    samples: itemSample,
  },
  archiveItem: {
    kind: 'action',
    label: 'Archive an Item',
    description: 'Archives an item.',
    expect: [itemId()],
    api: { url: '/items/{{parameters.itemId}}/archive', method: 'POST', body: {}, ...out('{{body}}') },
    interface: okInterface,
  },
  deleteItem: {
    kind: 'action',
    label: 'Delete an Item',
    description: 'Moves an item to the trash (restorable for 30 days).',
    expect: [itemId()],
    api: { url: '/items/{{parameters.itemId}}', method: 'DELETE', ...out('{{body}}') },
    interface: okInterface,
  },
  duplicateItem: {
    kind: 'action',
    label: 'Duplicate an Item',
    description: 'Duplicates an item, optionally with its updates.',
    expect: [itemId(), { name: 'withUpdates', label: 'With updates', type: 'boolean', default: false }],
    api: {
      url: '/items/{{parameters.itemId}}/duplicate',
      method: 'POST',
      qs: flat,
      body: { with_updates: '{{parameters.withUpdates}}' },
      ...out('{{body}}'),
    },
    interface: itemInterface,
    samples: itemSample,
  },
  moveItemToGroup: {
    kind: 'action',
    label: 'Move an Item to a Group',
    description: 'Moves an item to another group of its board.',
    expect: [board([group(true)]), itemId()],
    api: {
      url: '/items/{{parameters.itemId}}/move-to-group',
      method: 'POST',
      qs: flat,
      body: { group_id: '{{parameters.groupId}}' },
      ...out('{{body}}'),
    },
    interface: itemInterface,
    samples: itemSample,
  },
  moveItemToBoard: {
    kind: 'action',
    label: 'Move an Item to a Board',
    description:
      'Moves an item to another board. Columns are matched by type and title (else the only column of that type), as the move dialog proposes.',
    expect: [itemId(), board([group()], 'Target board')],
    api: {
      // No mapping: the server maps the columns itself.
      url: '/items/{{parameters.itemId}}/move-to-board',
      method: 'POST',
      body: { board_id: '{{parameters.boardId}}', group_id: '{{parameters.groupId}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Item ID', type: 'text' },
      { name: 'board_id', label: 'Board ID', type: 'text' },
    ],
  },
  createSubitem: {
    kind: 'action',
    label: 'Create a Subitem',
    description: 'Creates a subitem under an item, with the sub-board’s column values.',
    expect: [
      board(['rpc://columnFields?subitems=true'], 'Board of the parent item'),
      itemId('Parent item ID'),
      text('name', 'Name', { required: true }),
    ],
    api: {
      url: '/items/{{parameters.itemId}}/subitems',
      method: 'POST',
      qs: flat,
      body: { name: '{{parameters.name}}', values },
      ...out('{{body}}'),
    },
    interface: itemInterface,
    samples: itemSample,
  },
  updateSubitem: {
    kind: 'action',
    label: 'Update a Subitem',
    description: 'Changes a subitem’s name and column values.',
    expect: [
      board(['rpc://columnFields?subitems=true'], 'Board of the parent item'),
      itemId('Subitem ID'),
      text('name', 'New name', { help: 'Leave empty to keep the name.' }),
    ],
    api: {
      url: '/items/{{parameters.itemId}}',
      method: 'PATCH',
      qs: flat,
      body: { name: '{{parameters.name}}', values },
      ...out('{{body}}'),
    },
    interface: itemInterface,
    samples: itemSample,
  },
  moveSubitem: {
    kind: 'action',
    label: 'Move a Subitem',
    description: 'Moves a subitem (with its own subitems) under another item or subitem of the same board.',
    expect: [
      itemId('Subitem ID'),
      text('parentItemId', 'New parent item ID', { required: true }),
      {
        name: 'position',
        label: 'Position',
        type: 'select',
        default: 'bottom',
        options: [
          { label: 'Last', value: 'bottom' },
          { label: 'First', value: 'top' },
        ],
      },
    ],
    api: {
      url: '/items/{{parameters.itemId}}/reparent',
      method: 'POST',
      body: { parent_item_id: '{{parameters.parentItemId}}', position: '{{parameters.position}}' },
      ...out('{{body}}'),
    },
    interface: okInterface,
  },
  archiveSubitem: {
    kind: 'action',
    label: 'Archive a Subitem',
    description: 'Archives a subitem.',
    expect: [itemId('Subitem ID')],
    api: { url: '/items/{{parameters.itemId}}/archive', method: 'POST', body: {}, ...out('{{body}}') },
    interface: okInterface,
  },
  deleteSubitem: {
    kind: 'action',
    label: 'Delete a Subitem',
    description: 'Moves a subitem to the trash (restorable for 30 days).',
    expect: [itemId('Subitem ID')],
    api: { url: '/items/{{parameters.itemId}}', method: 'DELETE', ...out('{{body}}') },
    interface: okInterface,
  },
  createUpdate: {
    kind: 'action',
    label: 'Create an Update',
    description: 'Posts an update (comment) on an item.',
    expect: [itemId(), text('body', 'Text', { required: true, multiline: true })],
    api: {
      url: '/items/{{parameters.itemId}}/updates',
      method: 'POST',
      body: { body: '{{parameters.body}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Update ID', type: 'text' },
      { name: 'item_id', label: 'Item ID', type: 'text' },
      { name: 'body', label: 'Text', type: 'text' },
      { name: 'created_at', label: 'Created at', type: 'date' },
    ],
  },
  replyToUpdate: {
    kind: 'action',
    label: 'Reply to an Update',
    description: 'Replies to an update.',
    expect: [
      text('updateId', 'Update ID', { required: true }),
      text('body', 'Text', { required: true, multiline: true }),
    ],
    api: {
      url: '/updates/{{parameters.updateId}}/replies',
      method: 'POST',
      body: { body: '{{parameters.body}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Reply ID', type: 'text' },
      { name: 'body', label: 'Text', type: 'text' },
      { name: 'created_at', label: 'Created at', type: 'date' },
    ],
  },
  uploadFile: {
    kind: 'action',
    label: 'Upload a File',
    description: 'Uploads a file to a files column of an item.',
    expect: [
      board([
        {
          name: 'columnId',
          label: 'Files column',
          type: 'select',
          required: true,
          options: 'rpc://listColumns?kind=files',
        },
      ]),
      itemId(),
      { name: 'fileName', label: 'File name', type: 'filename', required: true, semantic: 'file:name' },
      { name: 'data', label: 'Data', type: 'buffer', required: true, semantic: 'file:data' },
      text('mime', 'Content type', { advanced: true, help: 'e.g. application/pdf (default application/octet-stream)' }),
    ],
    api: [
      {
        url: '/files/presign',
        method: 'POST',
        body: {
          name: "{{ifempty(parameters.fileName, 'file')}}",
          size: '{{length(parameters.data)}}',
          mime: "{{ifempty(parameters.mime, 'application/octet-stream')}}",
        },
        response: { temp: { presigned: '{{body}}' } },
      },
      {
        // The presigned URL carries its own authorisation: the API token is not sent to storage. Local storage
        // answers a path (`/files/up/…`): it is on the instance's origin.
        url: `{{if(substring(temp.presigned.upload_url, 0, 1) == '/', ${originOf('connection.baseUrl')} + temp.presigned.upload_url, temp.presigned.upload_url)}}`,
        method: 'PUT',
        headers: '{{temp.presigned.headers}}',
        type: 'binary',
        body: '{{parameters.data}}',
        response: { type: 'text' },
      },
      {
        url: '/files/{{temp.presigned.file_id}}/complete',
        method: 'POST',
        body: {},
        response: { temp: { file: '{{body}}' } },
      },
      {
        url: '/items/{{parameters.itemId}}/cells/{{parameters.columnId}}/files',
        method: 'POST',
        body: { file_ids: ['{{temp.presigned.file_id}}'] },
        ...out('{{temp.file}}'),
      },
    ],
    interface: [
      { name: 'id', label: 'File ID', type: 'text' },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'size', label: 'Size', type: 'number' },
      { name: 'mime', label: 'Content type', type: 'text' },
    ],
  },
  createGroup: {
    kind: 'action',
    label: 'Create a Group',
    description: 'Adds a group to a board.',
    expect: [board(), text('title', 'Title', { required: true })],
    api: {
      url: '/boards/{{parameters.boardId}}/groups',
      method: 'POST',
      body: { title: '{{parameters.title}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Group ID', type: 'text' },
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'color', label: 'Color', type: 'text' },
    ],
  },
  // ── 0.3: what the n8n node 0.3.0 added ──
  applyItemTemplate: {
    kind: 'action',
    label: 'Create an Item From a Template',
    description:
      'A new item with its subitems from one of the board’s item templates — or the template’s subitems under an existing item. One undo for all of it.',
    expect: [
      board([
        { name: 'templateId', label: 'Template', type: 'select', required: true, options: 'rpc://listItemTemplates' },
        group(),
      ]),
      text('parentItemId', 'Under item ID', { help: 'Optional: add the template’s subitems under this item instead.' }),
      {
        name: 'variables',
        label: 'Variables',
        type: 'any',
        help: 'Answers to the template’s variables by key, e.g. {"name": "Acme"}.',
      },
    ],
    api: {
      url: '/item-templates/{{parameters.templateId}}/apply',
      method: 'POST',
      body: {
        group_id: '{{parameters.groupId}}',
        parent_item_id: '{{parameters.parentItemId}}',
        variables: '{{ifempty(parameters.variables, emptycollection)}}',
      },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'item_id', label: 'Item ID', type: 'text' },
      { name: 'created', label: 'Items made', type: 'number' },
      { name: 'batch_id', label: 'Undo batch ID', type: 'text' },
      { name: 'skipped', label: 'Values not set', type: 'array' },
    ],
  },
  moveSubitemUp: {
    kind: 'action',
    label: 'Move a Subitem Up a Level',
    description: 'Moves a subitem under its grandparent; a first-level subitem becomes an item of the board.',
    expect: [itemId('Subitem ID')],
    api: { url: '/items/{{parameters.itemId}}/outdent', method: 'POST', body: {}, ...out('{{body}}') },
    interface: okInterface,
  },
  tickUpdateTask: {
    kind: 'action',
    label: 'Tick a Check Box of an Update',
    description: 'Ticks or clears one check box of an update or reply (counted from 1, in the text’s order).',
    expect: [
      text('updateId', 'Update ID', { required: true }),
      { name: 'index', label: 'Check box number', type: 'uinteger', required: true, default: 1 },
      { name: 'checked', label: 'Checked', type: 'boolean', default: true },
    ],
    api: {
      url: '/updates/{{parameters.updateId}}/tasks/{{parameters.index - 1}}',
      method: 'PUT',
      body: { checked: '{{parameters.checked}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Update ID', type: 'text' },
      { name: 'item_id', label: 'Item ID', type: 'text' },
    ],
  },
  addFileLink: {
    kind: 'action',
    label: 'Add a Link to a Files Column',
    description: 'Adds a web link to a files column of an item, beside its files.',
    expect: [
      board([
        {
          name: 'columnId',
          label: 'Files column',
          type: 'select',
          required: true,
          options: 'rpc://listColumns?kind=files',
        },
      ]),
      itemId(),
      text('url', 'URL', { required: true, help: 'An http(s) address; "example.com" gets https://.' }),
      text('name', 'Link name', { help: 'Shown instead of the address.' }),
    ],
    api: {
      url: '/items/{{parameters.itemId}}/cells/{{parameters.columnId}}/links',
      method: 'POST',
      body: { url: '{{parameters.url}}', name: '{{ifempty(parameters.name, omit)}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Link ID', type: 'text' },
      { name: 'url', label: 'URL', type: 'url' },
      { name: 'name', label: 'Name', type: 'text' },
    ],
  },
  ...Object.fromEntries(
    (['start', 'stop'] as const).map((op) => [
      op === 'start' ? 'startTimer' : 'stopTimer',
      {
        kind: 'action',
        label: op === 'start' ? 'Start a Timer' : 'Stop a Timer',
        description: `${op === 'start' ? 'Starts' : 'Stops'} the token owner’s timer on a timer column of an item.`,
        expect: [timerColumn(), itemId()],
        api: {
          url: `/items/{{parameters.itemId}}/time/${op}`,
          method: 'POST',
          body: { column_id: '{{parameters.columnId}}' },
          ...out('{{body}}'),
        },
        interface: timeEntryInterface,
      } satisfies ModuleSpec,
    ]),
  ),
  addTimeEntry: {
    kind: 'action',
    label: 'Log Time',
    description: 'Logs time by hand on a timer column (at most 24 hours, not in the future).',
    expect: [
      timerColumn(),
      itemId(),
      { name: 'startedAt', label: 'Started at', type: 'date', required: true },
      { name: 'minutes', label: 'Minutes', type: 'uinteger', required: true },
      text('note', 'Note'),
    ],
    api: {
      url: '/items/{{parameters.itemId}}/time/entries',
      method: 'POST',
      body: {
        column_id: '{{parameters.columnId}}',
        started_at: '{{formatDate(parameters.startedAt, "YYYY-MM-DDTHH:mm:ss.SSSZ")}}',
        duration_s: '{{parameters.minutes * 60}}',
        note: '{{ifempty(parameters.note, omit)}}',
      },
      ...out('{{body}}'),
    },
    interface: timeEntryInterface,
  },
  renameGroup: {
    kind: 'action',
    label: 'Rename a Group',
    description: 'Gives a group of a board a new title.',
    expect: [board([group(true)]), text('title', 'New title', { required: true })],
    api: {
      url: '/boards/{{parameters.boardId}}/groups/{{parameters.groupId}}',
      method: 'PATCH',
      body: { title: '{{parameters.title}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Group ID', type: 'text' },
      { name: 'title', label: 'Title', type: 'text' },
    ],
  },
  deleteGroup: {
    kind: 'action',
    label: 'Delete a Group',
    description: 'Deletes a group of a board (its items go to the trash with it).',
    expect: [board([group(true)])],
    api: {
      url: '/boards/{{parameters.boardId}}/groups/{{parameters.groupId}}',
      method: 'DELETE',
      ...out('{{body}}'),
    },
    interface: okInterface,
  },
  createColumn: {
    kind: 'action',
    label: 'Create a Column',
    description:
      'Adds a column to a board. A title the board already has gets the next free number. Types that need settings (formula, mirror, connected boards) are made with Make an API Call.',
    expect: [
      board(),
      text('title', 'Title', { required: true }),
      text('type', 'Type', { required: true, help: 'e.g. text, numbers, status, date, people, phone, email, file' }),
      text('description', 'Description'),
    ],
    api: {
      url: '/boards/{{parameters.boardId}}/columns',
      method: 'POST',
      body: {
        title: '{{parameters.title}}',
        type: '{{parameters.type}}',
        description: '{{ifempty(parameters.description, omit)}}',
      },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Column ID', type: 'text' },
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'type', label: 'Type', type: 'text' },
    ],
  },
  runAgent: {
    kind: 'action',
    label: 'Run an AI Agent',
    description: 'Runs an AI agent now with a prompt. The token needs the agents:run scope.',
    expect: [
      { name: 'agentId', label: 'Agent', type: 'select', required: true, options: 'rpc://listAgents' },
      text('prompt', 'Prompt', { required: true, multiline: true, help: 'What the agent should do now.' }),
      text('itemId', 'Item ID', { help: 'Optional: an item the run is about.' }),
      {
        name: 'dryRun',
        label: 'Dry run',
        type: 'boolean',
        default: false,
        help: 'Write tools only say what they would do.',
      },
    ],
    api: {
      url: '/agents/{{parameters.agentId}}/runs',
      method: 'POST',
      body: { prompt: '{{parameters.prompt}}', item_id: '{{parameters.itemId}}', dry_run: '{{parameters.dryRun}}' },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'id', label: 'Run ID', type: 'text' },
      { name: 'agent_id', label: 'Agent ID', type: 'text' },
      { name: 'status', label: 'Status', type: 'text' },
      { name: 'final_text', label: 'Answer', type: 'text' },
      { name: 'error', label: 'Error', type: 'text' },
    ],
  },
  getBoardSchema: {
    kind: 'action',
    label: 'Get a Board Schema',
    description: 'Returns a board’s groups and columns (type, options, value schema).',
    expect: [board()],
    api: { url: schemaUrl, ...out('{{body}}') },
    interface: [
      { name: 'id', label: 'Board ID', type: 'text' },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'groups', label: 'Groups', type: 'array' },
      { name: 'columns', label: 'Columns', type: 'array' },
      { name: 'subitems', label: 'Subitems', type: 'any' },
    ],
  },
};

const searchModules: Record<string, ModuleSpec> = {
  searchItems: {
    kind: 'search',
    label: 'Search Items',
    description: 'Lists a board’s items matching free text and column filters (all pages).',
    expect: [board([filtersParam()]), text('search', 'Search text'), limit(100)],
    api: {
      url: '/boards/{{parameters.boardId}}/items/query',
      method: 'POST',
      qs: flat,
      body: { limit: 100, search: '{{parameters.search}}', rules: '{{parameters.filters}}' },
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
      pagination: { body: { cursor: '{{body.next_cursor}}' }, condition: '{{body.next_cursor}}' },
    },
    interface: itemInterface,
    samples: itemSample,
  },
  findItems: {
    kind: 'search',
    label: 'Find Items by Column Value',
    description:
      'Finds items by a column value: phone numbers match by digits, emails and text ignore case. Use the column "name" for the item name.',
    expect: findParams(),
    api: {
      url: '/boards/{{parameters.boardId}}/items/find',
      method: 'POST',
      qs: flat,
      body: findBody,
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
    },
    interface: itemInterface,
    samples: itemSample,
  },
  getSubitems: {
    kind: 'search',
    label: 'Get Subitems of an Item',
    description: 'Lists the subitems right under an item (or under a subitem), in their order.',
    expect: [itemId('Parent item ID'), limit(100)],
    api: {
      url: '/items/{{parameters.itemId}}/subitems',
      qs: flat,
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
    },
    interface: itemInterface,
    samples: itemSample,
  },
  searchSubitems: {
    kind: 'search',
    label: 'Search Subitems',
    description: 'Lists the subitems of a board matching free text and subitem column filters (all pages).',
    expect: [board([filtersParam(true)], 'Board of the parent items'), text('search', 'Search text'), limit(100)],
    api: [
      { url: schemaUrl, response: { temp: { schema: '{{body}}' } } },
      {
        url: '/boards/{{temp.schema.subitems.board_id}}/items/query',
        method: 'POST',
        qs: flat,
        body: { limit: 100, search: '{{parameters.search}}', rules: '{{parameters.filters}}' },
        response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
        pagination: { body: { cursor: '{{body.next_cursor}}' }, condition: '{{body.next_cursor}}' },
      },
    ],
    interface: itemInterface,
    samples: itemSample,
  },
  findSubitems: {
    kind: 'search',
    label: 'Find Subitems by Column Value',
    description: 'Finds subitems by a value of a subitem column (phone by digits, emails and text ignore case).',
    expect: findParams(true),
    api: [
      { url: schemaUrl, response: { temp: { schema: '{{body}}' } } },
      {
        url: '/boards/{{temp.schema.subitems.board_id}}/items/find',
        method: 'POST',
        qs: flat,
        body: findBody,
        response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
      },
    ],
    interface: itemInterface,
    samples: itemSample,
  },
  listUsers: {
    kind: 'search',
    label: 'List Users',
    description: 'Lists the active members of the account.',
    expect: [text('q', 'Search', { help: 'Name or email contains.' }), limit(100)],
    api: {
      url: '/users',
      qs: { status: 'active', q: '{{parameters.q}}' },
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
    },
    interface: [
      { name: 'user_id', label: 'User ID', type: 'text' },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'role', label: 'Role', type: 'text' },
    ],
  },
  getTimeEntries: {
    kind: 'search',
    label: 'Get the Time Log of an Item',
    description: 'Lists an item’s time entries, newest first.',
    expect: [itemId(), limit(100)],
    api: {
      url: '/items/{{parameters.itemId}}/time/entries',
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
    },
    interface: timeEntryInterface,
  },
  searchEverything: {
    kind: 'search',
    label: 'Search Everything',
    description:
      'Items (name or values), boards, updates and people matching a text (2+ characters) that the token can see.',
    expect: [
      text('q', 'Text', { required: true }),
      { name: 'archived', label: 'Include archived items', type: 'boolean', default: false },
    ],
    api: {
      url: '/search',
      qs: { q: '{{parameters.q}}', archived: "{{if(parameters.archived, '1', omit)}}" },
      ...out('{{body}}'),
    },
    interface: [
      { name: 'items', label: 'Items', type: 'array' },
      { name: 'boards', label: 'Boards', type: 'array' },
      { name: 'updates', label: 'Updates', type: 'array' },
      { name: 'people', label: 'People', type: 'array' },
    ],
  },
  listTeams: {
    kind: 'search',
    label: 'List Teams',
    description: 'Lists the account’s teams with their members.',
    expect: [limit(100)],
    api: {
      url: '/teams',
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
    },
    interface: [
      { name: 'id', label: 'Team ID', type: 'text' },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'member_ids', label: 'Member IDs', type: 'array' },
    ],
  },
  listBoards: {
    kind: 'search',
    label: 'List Boards',
    description: 'Lists the boards the token can open.',
    expect: [text('q', 'Search', { help: 'Name contains.' }), limit(100)],
    api: {
      url: '/boards',
      qs: { q: '{{parameters.q}}' },
      response: { limit: '{{parameters.limit}}', iterate: '{{body.data}}', output: '{{item}}' },
    },
    interface: [
      { name: 'id', label: 'Board ID', type: 'text' },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'workspace_id', label: 'Workspace ID', type: 'text' },
    ],
  },
};

const universalModules: Record<string, ModuleSpec> = {
  makeApiCall: {
    kind: 'universal',
    label: 'Make an API Call',
    description: `Any ${PRODUCT_NAME} REST call with this connection (see /api/docs on your instance).`,
    expect: [
      text('url', 'URL', { required: true, help: 'A path under /api/v1, e.g. /boards' }),
      {
        name: 'method',
        label: 'Method',
        type: 'select',
        required: true,
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ label: m, value: m })),
      },
      {
        name: 'headers',
        label: 'Headers',
        type: 'array',
        spec: [text('key', 'Key'), text('value', 'Value')],
      },
      { name: 'qs', label: 'Query string', type: 'array', spec: [text('key', 'Key'), text('value', 'Value')] },
      { name: 'body', label: 'Body', type: 'any', help: 'JSON body.' },
    ],
    api: {
      url: '{{parameters.url}}',
      method: '{{parameters.method}}',
      headers: '{{toCollection(parameters.headers, "key", "value")}}',
      qs: '{{toCollection(parameters.qs, "key", "value")}}',
      body: '{{parameters.body}}',
      response: { output: { headers: '{{headers}}', statusCode: '{{statusCode}}', body: '{{body}}' } },
    },
    interface: [
      { name: 'statusCode', label: 'Status code', type: 'number' },
      { name: 'headers', label: 'Headers', type: 'any' },
      { name: 'body', label: 'Body', type: 'any' },
    ],
  },
};

export const modules: Record<string, ModuleSpec> = {
  ...triggerModules,
  ...actionModules,
  ...searchModules,
  ...universalModules,
};

export const groups: { label: string; modules: string[] }[] = [
  { label: 'Triggers', modules: Object.keys(triggerModules) },
  {
    label: 'Items',
    modules: [
      'createItem',
      'applyItemTemplate',
      'updateItem',
      'getItem',
      'searchItems',
      'findItems',
      'moveItemToGroup',
      'moveItemToBoard',
      'duplicateItem',
      'archiveItem',
      'deleteItem',
    ],
  },
  {
    label: 'Subitems',
    modules: [
      'createSubitem',
      'updateSubitem',
      'getSubitems',
      'searchSubitems',
      'findSubitems',
      'moveSubitem',
      'moveSubitemUp',
      'archiveSubitem',
      'deleteSubitem',
    ],
  },
  {
    label: 'Updates and files',
    modules: ['createUpdate', 'replyToUpdate', 'tickUpdateTask', 'uploadFile', 'addFileLink'],
  },
  { label: 'Time tracking', modules: ['startTimer', 'stopTimer', 'addTimeEntry', 'getTimeEntries'] },
  {
    label: 'Boards, people and agents',
    modules: [
      'listBoards',
      'getBoardSchema',
      'createGroup',
      'renameGroup',
      'deleteGroup',
      'createColumn',
      'searchEverything',
      'listUsers',
      'listTeams',
      'runAgent',
    ],
  },
  { label: 'Other', modules: ['makeApiCall'] },
];

export const app = {
  name: APP_NAME,
  label: PRODUCT_NAME,
  description: `Boards, items, subitems, updates, files and AI agents of ${PRODUCT_NAME}: instant triggers that register their own webhooks, actions and searches with each board's columns.`,
  language: 'en',
  theme: '#5b5bd6',
  version: 1,
};
