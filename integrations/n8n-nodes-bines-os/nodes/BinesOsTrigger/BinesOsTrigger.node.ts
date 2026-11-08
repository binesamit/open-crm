// SPDX-License-Identifier: MIT
import {
  NodeConnectionTypes,
  type IDataObject,
  type IHookFunctions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from 'n8n-workflow';
import { CREDENTIAL_NAME, PRODUCT_NAME, TRIGGER_EVENTS } from '../shared/constants';
import * as load from '../shared/loadOptions';
import { handleDelivery } from './delivery';
import { checkExists, create, remove, type HookState } from './hooks';

const forEvents = (events: string[]) => ({ show: { event: events } });

export class BinesOsTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: `${PRODUCT_NAME} Trigger`,
    name: 'binesOsTrigger',
    icon: 'file:binesOs.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: `Starts the workflow when something happens on a ${PRODUCT_NAME} board`,
    defaults: { name: `${PRODUCT_NAME} Trigger` },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL_NAME, required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName: 'Board Name or ID',
        name: 'boardId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getBoards' },
        required: true,
        default: '',
        description:
          'For subitem events: the board of the parent items (the subitem columns load from its sub-board). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        required: true,
        default: 'item_created',
        options: TRIGGER_EVENTS.map((e) => ({ name: e.name, value: e.value, description: e.description })),
      },
      {
        displayName: 'Column Name or ID',
        name: 'columnId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['boardId'] },
        required: true,
        default: '',
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        displayOptions: forEvents(['specific_column_changed']),
      },
      {
        displayName: 'Subitem Column Name or ID',
        name: 'subitemColumnId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getSubitemColumns', loadOptionsDependsOn: ['boardId'] },
        default: '',
        description:
          'A column of the subitems; empty = any column. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: forEvents(['subitem_column_changed']),
      },
      {
        displayName: 'Status Column Name or ID',
        name: 'statusColumnId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getStatusColumns', loadOptionsDependsOn: ['boardId', 'event'] },
        default: '',
        description:
          'Empty = any status column (of the subitems, for a subitem event). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: forEvents(['status_changed', 'subitem_status_changed']),
      },
      {
        displayName: 'Label Name or ID',
        name: 'label',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getLabels', loadOptionsDependsOn: ['boardId', 'event', 'statusColumnId'] },
        default: '',
        description:
          'Only when the status becomes this label (empty = any). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: forEvents(['status_changed', 'subitem_status_changed']),
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
        displayOptions: forEvents(['item_moved_to_specific_group']),
      },
      {
        displayName: 'Channel',
        name: 'channel',
        type: 'string',
        default: '',
        description: 'Only the "send to integrations" actions that name this channel (empty = every one on the board)',
        displayOptions: forEvents(['automation_sent']),
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Include Item',
            name: 'includeItem',
            type: 'boolean',
            default: true,
            description: 'Whether the event carries the item with its column values (no second call needed)',
          },
          {
            displayName: 'Verify Signature',
            name: 'verifySignature',
            type: 'boolean',
            default: true,
            description: "Whether to refuse calls that are not signed with this subscription's secret",
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      getBoards: load.getBoards,
      getGroups: load.getGroups,
      getColumns: load.getColumns,
      getSubitemColumns: load.getSubitemColumns,
      getStatusColumns: load.getStatusColumns,
      getLabels: load.getLabels,
    },
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        return checkExists.call(this);
      },
      async create(this: IHookFunctions): Promise<boolean> {
        return create.call(this);
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        return remove.call(this);
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject();
    const state = this.getWorkflowStaticData('node') as HookState;
    const options = this.getNodeParameter('options', {}) as IDataObject;
    const raw = (req as unknown as { rawBody?: Buffer | string }).rawBody;
    const outcome = handleDelivery({
      body: this.getBodyData(),
      headers: this.getHeaderData() as Record<string, string | string[] | undefined>,
      rawBody: raw === undefined ? undefined : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw),
      secret: state.secret,
      verify: options.verifySignature !== false,
    });
    if (outcome.kind === 'challenge') return { webhookResponse: outcome.response };
    if (outcome.kind === 'reject') {
      const res = this.getResponseObject();
      res.status(outcome.status).json({ error: outcome.message });
      return { noWebhookResponse: true };
    }
    return { workflowData: [this.helpers.returnJsonArray([outcome.json])] };
  }
}
