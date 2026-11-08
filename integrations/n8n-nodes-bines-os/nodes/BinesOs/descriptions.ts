// SPDX-License-Identifier: MIT
import type { INodeProperties } from 'n8n-workflow';
import { PRODUCT_NAME } from '../shared/constants';

/** The "Bines OS" node's fields: resource → operation → the fields each operation needs. */

const show = (resource: string[], operation?: string[]) => ({
  show: { resource, ...(operation ? { operation } : {}) },
});

export const resourceField: INodeProperties = {
  displayName: 'Resource',
  name: 'resource',
  type: 'options',
  noDataExpression: true,
  default: 'item',
  options: [
    { name: 'AI Agent', value: 'agent' },
    { name: 'API Call', value: 'apiCall' },
    { name: 'Board', value: 'board' },
    { name: 'Column', value: 'column' },
    { name: 'File', value: 'file' },
    { name: 'Group', value: 'group' },
    { name: 'Item', value: 'item' },
    { name: 'Search', value: 'search' },
    { name: 'Subitem', value: 'subitem' },
    { name: 'Time Tracking', value: 'time' },
    { name: 'Update', value: 'update' },
    { name: 'User', value: 'user' },
  ],
};

/**
 * Column types a new column can be made with from here — those that need no settings to work. Others (formula,
 * mirror, connected boards…) are made in the app or with the API Call operation and their settings.
 */
const NEW_COLUMN_TYPES: [string, string][] = [
  ['Check Box', 'checkbox'],
  ['Color', 'color_picker'],
  ['Country', 'country'],
  ['Creation Log', 'creation_log'],
  ['Date', 'date'],
  ['Dropdown', 'dropdown'],
  ['Email', 'email'],
  ['Files', 'file'],
  ['Hour', 'hour'],
  ['Item ID', 'item_id'],
  ['Last Updated', 'last_updated'],
  ['Link', 'link'],
  ['Location', 'location'],
  ['Long Text', 'long_text'],
  ['Numbers', 'numbers'],
  ['People', 'people'],
  ['Phone', 'phone'],
  ['Rating', 'rating'],
  ['Status', 'status'],
  ['Tags', 'tags'],
  ['Text', 'text'],
  ['Time Tracking', 'time_tracking'],
  ['Timeline', 'timeline'],
  ['Vote', 'vote'],
  ['Week', 'week'],
  ['World Clock', 'world_clock'],
];

const operations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['item']),
    default: 'create',
    options: [
      { name: 'Apply Template', value: 'applyTemplate', action: 'Create an item from a template' },
      { name: 'Archive', value: 'archive', action: 'Archive an item' },
      { name: 'Create', value: 'create', action: 'Create an item' },
      { name: 'Delete', value: 'delete', action: 'Delete an item' },
      { name: 'Duplicate', value: 'duplicate', action: 'Duplicate an item' },
      { name: 'Find by Column Value', value: 'find', action: 'Find items by a column value' },
      { name: 'Get', value: 'get', action: 'Get an item' },
      { name: 'Get Many', value: 'getAll', action: 'Get many items' },
      { name: 'Move to Board', value: 'moveToBoard', action: 'Move an item to another board' },
      { name: 'Move to Group', value: 'moveToGroup', action: 'Move an item to a group' },
      { name: 'Update', value: 'update', action: 'Update an item' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['subitem']),
    default: 'create',
    options: [
      { name: 'Archive', value: 'archive', action: 'Archive a subitem' },
      { name: 'Create', value: 'create', action: 'Create a subitem' },
      { name: 'Delete', value: 'delete', action: 'Delete a subitem' },
      { name: 'Find by Column Value', value: 'find', action: 'Find subitems by a column value' },
      { name: 'Get', value: 'get', action: 'Get a subitem' },
      { name: 'Get Many', value: 'getAll', action: 'Get many subitems of a board' },
      { name: 'Get Many of an Item', value: 'getForItem', action: 'Get the subitems of an item' },
      { name: 'Move to Another Item', value: 'move', action: 'Move a subitem under another item' },
      {
        name: 'Move Up a Level',
        value: 'moveUp',
        action: 'Move a subitem up a level',
        description: 'Under its grandparent — a first-level subitem becomes an item of the board',
      },
      { name: 'Update', value: 'update', action: 'Update a subitem' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['update']),
    default: 'create',
    options: [
      { name: 'Create', value: 'create', action: 'Post an update on an item' },
      { name: 'Reply', value: 'reply', action: 'Reply to an update' },
      { name: 'Tick Check Box', value: 'tickTask', action: 'Tick or clear a check box of an update' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['file']),
    default: 'upload',
    options: [
      { name: 'Add Link to Column', value: 'addLink', action: 'Add a web link to a files column' },
      { name: 'Upload to Column', value: 'upload', action: 'Upload a file to a files column' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['group']),
    default: 'create',
    options: [
      { name: 'Create', value: 'create', action: 'Create a group' },
      { name: 'Delete', value: 'delete', action: 'Delete a group' },
      { name: 'Rename', value: 'update', action: 'Rename a group' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['column']),
    default: 'create',
    options: [{ name: 'Create', value: 'create', action: 'Create a column' }],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['time']),
    default: 'start',
    options: [
      { name: 'Add Entry', value: 'addEntry', action: 'Log time by hand' },
      { name: 'Get Entries', value: 'getEntries', action: 'Get the time log of an item' },
      { name: 'Start Timer', value: 'start', action: 'Start a timer' },
      { name: 'Stop Timer', value: 'stop', action: 'Stop a timer' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['search']),
    default: 'search',
    options: [
      {
        name: 'Search Everything',
        value: 'search',
        action: 'Search everything',
        description: 'Items, boards, updates and people you can see',
      },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['agent']),
    default: 'run',
    options: [{ name: 'Run', value: 'run', action: 'Run an AI agent' }],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['user']),
    default: 'getAll',
    options: [
      { name: 'Get Many', value: 'getAll', action: 'Get many users' },
      { name: 'Get Teams', value: 'getTeams', action: 'Get the teams and their members' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['board']),
    default: 'getSchema',
    options: [
      { name: 'Get Many', value: 'getAll', action: 'Get many boards' },
      { name: 'Get Schema', value: 'getSchema', action: 'Get a board s groups and columns' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(['apiCall']),
    default: 'call',
    options: [{ name: 'Make an API Call', value: 'call', action: 'Make an API call' }],
  },
];

const boardField = (resource: string, ops: string[]): INodeProperties => ({
  displayName: 'Board Name or ID',
  name: 'boardId',
  type: 'options',
  typeOptions: { loadOptionsMethod: 'getBoards' },
  required: true,
  default: '',
  description:
    'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
  displayOptions: show([resource], ops),
});

const itemIdField = (resource: string, ops: string[], displayName = 'Item ID'): INodeProperties => ({
  displayName,
  name: 'itemId',
  type: 'string',
  required: true,
  default: '',
  displayOptions: show([resource], ops),
});

const mapper = (resource: string, ops: string[], method: string, name = 'columns'): INodeProperties => ({
  displayName: 'Column Values',
  name,
  type: 'resourceMapper',
  noDataExpression: true,
  default: { mappingMode: 'defineBelow', value: null },
  description:
    'Each column in its own type. Status, dropdown, people, tags and connected items offer their values to pick; several values go in as an expression, comma-separated (labels, emails, names or IDs). A date takes YYYY-MM-DD (or YYYY-MM-DDTHH:MM). A JSON object is sent as the raw value.',
  typeOptions: {
    loadOptionsDependsOn: ['boardId', 'resource'],
    resourceMapper: {
      resourceMapperMethod: method,
      mode: 'add',
      fieldWords: { singular: 'column', plural: 'columns' },
      addAllFields: false,
      multiKeyMatch: false,
      supportAutoMap: true,
    },
  },
  displayOptions: show([resource], ops),
});

/** A value with a picker: the column's own values ("From List", searchable) or typed ("Value"). */
const valueLocator = (searchListMethod: string, description: string, required = false): INodeProperties => ({
  displayName: 'Value',
  name: 'value',
  type: 'resourceLocator',
  required,
  default: { mode: 'list', value: '' },
  description,
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      placeholder: 'Pick a value of the column…',
      typeOptions: { searchListMethod, searchable: true },
    },
    { displayName: 'Value', name: 'text', type: 'string', placeholder: 'e.g. 050-1234567' },
  ],
});

/** "Find by column value" of items or subitems. */
const findFields = (resource: string): INodeProperties[] => [
  {
    displayName: 'Column Name or ID',
    name: 'columnId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['boardId', 'resource'] },
    required: true,
    default: '',
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show([resource], ['find']),
  },
  {
    ...valueLocator(
      'searchFindValues',
      'Pick one of the column values (labels, people, connected items, values already used), or type one. Phone numbers match by their digits; emails and text ignore case.',
      true,
    ),
    displayOptions: show([resource], ['find']),
  },
  {
    displayName: 'Match',
    name: 'match',
    type: 'options',
    default: 'exact',
    options: [
      { name: 'Exact', value: 'exact' },
      { name: 'Contains', value: 'contains' },
    ],
    displayOptions: show([resource], ['find']),
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    typeOptions: { minValue: 1, maxValue: 50 },
    // 10 since 0.1: n8n does not save a parameter left at its default, so raising it would silently change every
    // saved workflow that relies on it.
    // eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-limit
    default: 10,
    description: 'Max number of results to return',
    displayOptions: show([resource], ['find']),
  },
];

const itemFields: INodeProperties[] = [
  boardField('item', ['create', 'update', 'getAll', 'find', 'moveToGroup', 'applyTemplate']),
  {
    displayName: 'Template Name or ID',
    name: 'templateId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getItemTemplates', loadOptionsDependsOn: ['boardId'] },
    required: true,
    default: '',
    description:
      'An item template of the board (with its subitems). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    displayOptions: show(['item'], ['applyTemplate']),
  },
  {
    displayName: 'Options',
    name: 'templateOptions',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: show(['item'], ['applyTemplate']),
    options: [
      {
        displayName: 'Group Name or ID',
        name: 'groupId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getGroups', loadOptionsDependsOn: ['boardId'] },
        default: '',
        description:
          'Empty = the board\'s first group. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Under Item ID',
        name: 'parentItemId',
        type: 'string',
        default: '',
        description: "Add the template's subitems under this existing item instead of making a new item",
      },
      {
        displayName: 'Position',
        name: 'position',
        type: 'options',
        default: 'bottom',
        options: [
          { name: 'Last', value: 'bottom' },
          { name: 'First', value: 'top' },
        ],
      },
      {
        displayName: 'Variables (JSON)',
        name: 'variables',
        type: 'json',
        default: '{}',
        description: 'Answers to the template\'s variables by key, e.g. {"name": "Acme", "start": "2026-11-01"}',
      },
    ],
  },
  itemIdField('item', ['update', 'get', 'delete', 'archive', 'duplicate', 'moveToGroup', 'moveToBoard']),
  {
    displayName: 'Name',
    name: 'name',
    type: 'string',
    required: true,
    default: '',
    displayOptions: show(['item'], ['create']),
  },
  {
    displayName: 'Group Name or ID',
    name: 'groupId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getGroups', loadOptionsDependsOn: ['boardId'] },
    default: '',
    description:
      'Empty = the board\'s first group. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    displayOptions: show(['item'], ['create']),
  },
  {
    displayName: 'Group Name or ID',
    name: 'groupId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getGroups', loadOptionsDependsOn: ['boardId'] },
    required: true,
    default: '',
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(['item'], ['moveToGroup']),
  },
  {
    displayName: 'New Name',
    name: 'name',
    type: 'string',
    default: '',
    description: 'Empty = keep the name',
    displayOptions: show(['item'], ['update']),
  },
  mapper('item', ['create', 'update'], 'getColumnFields'),
  {
    displayName: 'With Updates',
    name: 'withUpdates',
    type: 'boolean',
    default: false,
    description: "Whether to copy the item's updates too",
    displayOptions: show(['item'], ['duplicate']),
  },
  {
    displayName: 'Target Board Name or ID',
    name: 'targetBoardId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getBoards' },
    required: true,
    default: '',
    description:
      'Columns move to the target column with the same ID or title and type; the rest are dropped. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    displayOptions: show(['item'], ['moveToBoard']),
  },
  {
    displayName: 'Target Group Name or ID',
    name: 'targetGroupId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getTargetGroups', loadOptionsDependsOn: ['targetBoardId'] },
    default: '',
    description:
      'Empty = the target board\'s first group. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    displayOptions: show(['item'], ['moveToBoard']),
  },
  ...findFields('item'),
  // getAll
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    description: 'Whether to return all results or only up to a given limit',
    displayOptions: show(['item', 'subitem', 'user', 'board'], ['getAll']),
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    typeOptions: { minValue: 1 },
    default: 50,
    description: 'Max number of results to return',
    displayOptions: {
      show: { resource: ['item', 'subitem', 'user', 'board'], operation: ['getAll'], returnAll: [false] },
    },
  },
  {
    displayName: 'Filters',
    name: 'filters',
    type: 'fixedCollection',
    placeholder: 'Add Condition',
    typeOptions: { multipleValues: true },
    default: {},
    description: 'All conditions must match',
    displayOptions: show(['item', 'subitem'], ['getAll']),
    options: [
      {
        displayName: 'Condition',
        name: 'rules',
        values: [
          {
            displayName: 'Column Name or ID',
            name: 'columnId',
            type: 'options',
            typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['boardId', 'resource'] },
            default: '',
            description:
              'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
          },
          {
            displayName: 'Operator',
            name: 'operator',
            type: 'options',
            default: 'any_of',
            options: [
              { name: 'Contains Text', value: 'contains_text' },
              { name: 'Greater Than', value: 'greater_than' },
              { name: 'Is (Any Of)', value: 'any_of' },
              { name: 'Is Empty', value: 'is_empty' },
              { name: 'Is Not (None Of)', value: 'not_any_of' },
              { name: 'Is Not Empty', value: 'is_not_empty' },
              { name: 'Lower Than', value: 'lower_than' },
            ],
          },
          valueLocator(
            'searchFilterValues',
            'Pick a label, person, tag or connected item from the column, or type a value. Several values for "is (any of)" are comma-separated (labels by text, people / tags / items by ID); dates also take TODAY, THIS_WEEK, OVERDUE…',
          ),
        ],
      },
    ],
  },
  {
    displayName: 'Search',
    name: 'search',
    type: 'string',
    default: '',
    description: 'Free text over the name and the values',
    displayOptions: show(['item', 'subitem'], ['getAll']),
  },
];

const subitemFields: INodeProperties[] = [
  {
    ...boardField('subitem', ['create', 'update', 'getAll', 'find']),
    displayName: 'Parent Board Name or ID',
    description:
      'The board of the parent items — the subitem columns load from its sub-board. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
  },
  itemIdField('subitem', ['create', 'getForItem'], 'Parent Item ID'),
  itemIdField('subitem', ['update', 'get', 'archive', 'delete', 'move', 'moveUp'], 'Subitem ID'),
  {
    displayName: 'New Parent Item ID',
    name: 'parentItemId',
    type: 'string',
    required: true,
    default: '',
    description: 'An item of the same board (or another subitem of it) to move the subitem under',
    displayOptions: show(['subitem'], ['move']),
  },
  {
    displayName: 'Position',
    name: 'position',
    type: 'options',
    default: 'bottom',
    options: [
      { name: 'Last', value: 'bottom' },
      { name: 'First', value: 'top' },
    ],
    displayOptions: show(['subitem'], ['move']),
  },
  ...findFields('subitem'),
  {
    displayName: 'Name',
    name: 'name',
    type: 'string',
    required: true,
    default: '',
    displayOptions: show(['subitem'], ['create']),
  },
  {
    displayName: 'New Name',
    name: 'name',
    type: 'string',
    default: '',
    description: 'Empty = keep the name',
    displayOptions: show(['subitem'], ['update']),
  },
  mapper('subitem', ['create', 'update'], 'getSubitemColumnFields', 'subitemColumns'),
];

const updateFields: INodeProperties[] = [
  itemIdField('update', ['create']),
  {
    displayName: 'Update ID',
    name: 'updateId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: show(['update'], ['reply', 'tickTask']),
  },
  {
    displayName: 'Check Box Number',
    name: 'index',
    type: 'number',
    typeOptions: { minValue: 1 },
    required: true,
    default: 1,
    description: "Which check box of the update (or reply), counted from 1 in the text's order",
    displayOptions: show(['update'], ['tickTask']),
  },
  {
    displayName: 'Checked',
    name: 'checked',
    type: 'boolean',
    default: true,
    description: 'Whether to tick the box (or clear it)',
    displayOptions: show(['update'], ['tickTask']),
  },
  {
    displayName: 'Text',
    name: 'body',
    type: 'string',
    typeOptions: { rows: 4 },
    required: true,
    default: '',
    description: 'Plain text; mention someone with [@Name](user:USER_ID)',
    displayOptions: show(['update'], ['create', 'reply']),
  },
];

const fileFields: INodeProperties[] = [
  boardField('file', ['upload', 'addLink']),
  itemIdField('file', ['upload', 'addLink']),
  {
    displayName: 'Files Column Name or ID',
    name: 'columnId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getFileColumns', loadOptionsDependsOn: ['boardId'] },
    required: true,
    default: '',
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(['file'], ['upload', 'addLink']),
  },
  {
    displayName: 'URL',
    name: 'url',
    type: 'string',
    required: true,
    default: '',
    placeholder: 'https://example.com/brief',
    description: 'An http(s) address; "example.com" gets https://',
    displayOptions: show(['file'], ['addLink']),
  },
  {
    displayName: 'Link Name',
    name: 'linkName',
    type: 'string',
    default: '',
    description: 'Shown instead of the address (empty = the address)',
    displayOptions: show(['file'], ['addLink']),
  },
  {
    displayName: 'Input Binary Field',
    name: 'binaryPropertyName',
    type: 'string',
    required: true,
    default: 'data',
    hint: 'The name of the input binary field holding the file',
    displayOptions: show(['file'], ['upload']),
  },
];

const groupFields: INodeProperties[] = [
  boardField('group', ['create', 'update', 'delete']),
  {
    displayName: 'Group Name or ID',
    name: 'groupId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getGroups', loadOptionsDependsOn: ['boardId'] },
    required: true,
    default: '',
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(['group'], ['update', 'delete']),
  },
  {
    displayName: 'Title',
    name: 'title',
    type: 'string',
    required: true,
    default: '',
    displayOptions: show(['group'], ['create']),
  },
  {
    displayName: 'New Title',
    name: 'title',
    type: 'string',
    required: true,
    default: '',
    displayOptions: show(['group'], ['update']),
  },
];

const columnFields: INodeProperties[] = [
  boardField('column', ['create']),
  {
    displayName: 'Title',
    name: 'title',
    type: 'string',
    required: true,
    default: '',
    description: 'A title the board already has gets the next free number ("Status 2")',
    displayOptions: show(['column'], ['create']),
  },
  {
    displayName: 'Type',
    name: 'columnType',
    type: 'options',
    default: 'text',
    options: NEW_COLUMN_TYPES.map(([name, value]) => ({ name, value })),
    description: 'Column types that need settings (formula, mirror, connected boards…) are made with API Call',
    displayOptions: show(['column'], ['create']),
  },
  {
    displayName: 'Description',
    name: 'description',
    type: 'string',
    default: '',
    displayOptions: show(['column'], ['create']),
  },
];

const timeFields: INodeProperties[] = [
  {
    ...boardField('time', ['start', 'stop', 'addEntry']),
    description:
      'The item\'s board (for a subitem: its parent board, with On a Subitem on). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
  },
  {
    displayName: 'On a Subitem',
    name: 'onSubitem',
    type: 'boolean',
    default: false,
    description: "Whether the item is a subitem (its timer columns are the sub-board's)",
    displayOptions: show(['time'], ['start', 'stop', 'addEntry']),
  },
  itemIdField('time', ['start', 'stop', 'addEntry', 'getEntries']),
  {
    displayName: 'Timer Column Name or ID',
    name: 'columnId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getTimeColumns', loadOptionsDependsOn: ['boardId', 'onSubitem'] },
    required: true,
    default: '',
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(['time'], ['start', 'stop', 'addEntry']),
  },
  {
    displayName: 'Started At',
    name: 'startedAt',
    type: 'dateTime',
    required: true,
    default: '',
    displayOptions: show(['time'], ['addEntry']),
  },
  {
    displayName: 'Minutes',
    name: 'minutes',
    type: 'number',
    typeOptions: { minValue: 1, maxValue: 1440 },
    required: true,
    default: 30,
    description: 'How long (at most 24 hours; it may not end in the future)',
    displayOptions: show(['time'], ['addEntry']),
  },
  {
    displayName: 'Note',
    name: 'note',
    type: 'string',
    default: '',
    displayOptions: show(['time'], ['start', 'addEntry']),
  },
];

const searchFields: INodeProperties[] = [
  {
    displayName: 'Text',
    name: 'q',
    type: 'string',
    required: true,
    default: '',
    description: 'At least 2 characters: item names and values, boards, updates and people you can see',
    displayOptions: show(['search'], ['search']),
  },
  {
    displayName: 'Include Archived Items',
    name: 'archived',
    type: 'boolean',
    default: false,
    displayOptions: show(['search'], ['search']),
  },
];

const agentFields: INodeProperties[] = [
  {
    displayName: 'Agent Name or ID',
    name: 'agentId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getAgents' },
    required: true,
    default: '',
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(['agent'], ['run']),
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    typeOptions: { rows: 4 },
    required: true,
    default: '',
    description: 'What the agent should do now',
    displayOptions: show(['agent'], ['run']),
  },
  {
    displayName: 'Options',
    name: 'agentOptions',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: show(['agent'], ['run']),
    options: [
      {
        displayName: 'Item ID',
        name: 'itemId',
        type: 'string',
        default: '',
        description: 'An item the run is about',
      },
      {
        displayName: 'Dry Run',
        name: 'dryRun',
        type: 'boolean',
        default: false,
        description: 'Whether write tools only say what they would do',
      },
    ],
  },
];

const userFields: INodeProperties[] = [
  {
    displayName: 'Search',
    name: 'q',
    type: 'string',
    default: '',
    description: 'Part of a name or email',
    displayOptions: show(['user'], ['getAll']),
  },
];

const boardFields: INodeProperties[] = [
  boardField('board', ['getSchema']),
  {
    displayName: 'Name Contains',
    name: 'q',
    type: 'string',
    default: '',
    displayOptions: show(['board'], ['getAll']),
  },
];

const apiCallFields: INodeProperties[] = [
  {
    displayName: 'Method',
    name: 'method',
    type: 'options',
    default: 'GET',
    options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ name: m, value: m })),
    displayOptions: show(['apiCall']),
  },
  {
    displayName: 'Path',
    name: 'path',
    type: 'string',
    required: true,
    default: '/auth/me',
    placeholder: '/boards/BOARD_ID/items',
    description: `A path of the ${PRODUCT_NAME} REST API, after /api/v1 (see the API reference at /api/docs)`,
    displayOptions: show(['apiCall']),
  },
  {
    displayName: 'Query Parameters (JSON)',
    name: 'query',
    type: 'json',
    default: '{}',
    displayOptions: show(['apiCall']),
  },
  {
    displayName: 'Body (JSON)',
    name: 'body',
    type: 'json',
    default: '{}',
    displayOptions: { show: { resource: ['apiCall'], method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
  },
];

export const nodeProperties: INodeProperties[] = [
  resourceField,
  ...operations,
  ...itemFields,
  ...subitemFields,
  ...updateFields,
  ...fileFields,
  ...groupFields,
  ...columnFields,
  ...timeFields,
  ...searchFields,
  ...agentFields,
  ...userFields,
  ...boardFields,
  ...apiCallFields,
];
