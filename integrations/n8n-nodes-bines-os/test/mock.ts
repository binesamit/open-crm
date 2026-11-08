// SPDX-License-Identifier: MIT
import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import type { BoardSchema } from '../nodes/shared/values';

/** A fake n8n context: node parameters from a map, HTTP answered by a router, every call recorded. */
export type Call = { method: string; url: string; body?: unknown; qs?: IDataObject; auth: boolean };
export type Router = (call: Call) => unknown;

export const BASE = 'https://crm.example.com';

export const makeCtx = (opts: {
  params: Record<string, unknown> | Record<string, unknown>[];
  route: Router;
  input?: IDataObject[];
  staticData?: IDataObject;
  binary?: { fileName: string; mimeType: string; data: Buffer };
  webhookUrl?: string;
}) => {
  const calls: Call[] = [];
  const paramsOf = (i: number) =>
    Array.isArray(opts.params) ? (opts.params[i] ?? opts.params[0]!) : (opts.params as Record<string, unknown>);
  const request = (auth: boolean) => async (o: IHttpRequestOptions) => {
    const call: Call = { method: o.method ?? 'GET', url: o.url, body: o.body, qs: o.qs, auth };
    calls.push(call);
    const out = opts.route(call);
    if (out instanceof Error) throw out;
    return out;
  };
  const staticData = opts.staticData ?? {};
  const ctx = {
    calls,
    staticData,
    getNode: () => ({ id: 'n1', name: 'Bines OS', type: 'binesOs', typeVersion: 1, position: [0, 0], parameters: {} }),
    getCredentials: async () => ({ baseUrl: `${BASE}/`, apiToken: 'bos_pat_test' }),
    getNodeParameter: (name: string, a?: unknown, b?: unknown) => {
      // execute: (name, itemIndex, fallback); hooks / load options: (name, fallback)
      const i = typeof a === 'number' ? a : 0;
      const fallback = typeof a === 'number' ? b : a;
      const p = paramsOf(i);
      return name in p ? p[name] : fallback;
    },
    getCurrentNodeParameter: (name: string) => paramsOf(0)[name],
    getInputData: () => (opts.input ?? [{}]).map((json) => ({ json })),
    continueOnFail: () => false,
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => opts.webhookUrl ?? 'https://n8n.example.com/webhook/abc/webhook',
    getWorkflow: () => ({ id: 'wf1', name: 'Leads', active: true }),
    helpers: {
      httpRequestWithAuthentication: async function (_cred: string, o: IHttpRequestOptions) {
        return request(true)(o);
      },
      httpRequest: request(false),
      returnJsonArray: (rows: IDataObject[]) => rows.map((json) => ({ json })),
      assertBinaryData: () => ({
        fileName: opts.binary?.fileName,
        mimeType: opts.binary?.mimeType ?? 'application/octet-stream',
        data: '',
      }),
      getBinaryDataBuffer: async () => opts.binary?.data ?? Buffer.from(''),
    },
  };
  return ctx;
};

/** A board schema like `GET /boards/{id}/schema` answers. */
export const SCHEMA: BoardSchema = {
  id: 'b1',
  name: 'Leads',
  kind: 'public',
  groups: [
    { id: 'g1', title: 'New', color: 'blue' },
    { id: 'g2', title: 'Won', color: 'green' },
  ],
  columns: [
    {
      id: 'name',
      title: 'Name',
      type: 'name',
      description: null,
      writable: false,
      value_model: 'text',
      options: null,
      value_schema: null,
    },
    {
      id: 'status',
      title: 'Status',
      type: 'status',
      description: null,
      writable: true,
      value_model: 'label',
      options: [
        { id: 0, label: 'New', color: 'gray' },
        { id: 1, label: 'Done', color: 'forest' },
      ],
      value_schema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
    },
    {
      id: 'phone',
      title: 'Phone',
      type: 'phone',
      description: null,
      writable: true,
      value_model: 'text',
      options: null,
      value_schema: null,
    },
    {
      id: 'owner',
      title: 'Owner',
      type: 'people',
      description: null,
      writable: true,
      value_model: 'people',
      options: null,
      value_schema: null,
    },
    {
      id: 'due',
      title: 'Due',
      type: 'date',
      description: null,
      writable: true,
      value_model: 'date',
      options: null,
      value_schema: null,
    },
    {
      id: 'files',
      title: 'Files',
      type: 'file',
      description: null,
      writable: false,
      value_model: 'files',
      options: null,
      value_schema: null,
    },
    {
      id: 'country',
      title: 'Country',
      type: 'country',
      description: null,
      writable: true,
      value_model: 'text',
      options: null,
      value_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    },
  ],
  subitems: {
    board_id: 'b1s',
    columns: [
      {
        id: 'hours',
        title: 'Hours',
        type: 'numbers',
        description: null,
        writable: true,
        value_model: 'number',
        options: null,
        value_schema: { type: 'number' },
      },
      {
        id: 'stage',
        title: 'Stage',
        type: 'status',
        description: null,
        writable: true,
        value_model: 'label',
        options: [
          { id: 0, label: 'To do', color: 'gray' },
          { id: 5, label: 'Blocked', color: 'crimson' },
        ],
        value_schema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
      },
    ],
  },
};

export const MEMBERS = [
  { user_id: 'u1', name: 'Dana Levi', email: 'dana@example.com' },
  { user_id: 'u2', name: 'Avi Cohen', email: 'avi@example.com' },
];
