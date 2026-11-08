// SPDX-License-Identifier: MIT
import type { IDataObject, IHookFunctions } from 'n8n-workflow';
import { apiEventOf, TRIGGER_EVENTS, type TriggerEvent } from '../shared/constants';
import { nodeError } from '../shared/errors';
import { newSecret } from '../shared/signature';
import { apiRequest } from '../shared/transport';

/**
 * The REST-hook lifecycle of the trigger: n8n calls `create` when the workflow is switched on (or while it listens
 * for a test event), `checkExists` before that, and `delete` when it is switched off. The subscription id and its
 * signing secret live in the node's static data.
 */
export type HookState = { webhookId?: string; secret?: string; url?: string; event?: string };

export type TriggerSettings = {
  boardId: string;
  event: TriggerEvent;
  columnId?: string;
  subitemColumnId?: string;
  statusColumnId?: string;
  label?: string;
  groupId?: string;
  channel?: string;
  includeItem: boolean;
};

/** The subscription's `config` (the platform narrows the event with it). */
export const configOf = (s: TriggerSettings): IDataObject => {
  const def: IDataObject = { ...(TRIGGER_EVENTS.find((e) => e.value === s.event) ?? {}) };
  const config: IDataObject = { include_item: s.includeItem };
  if (s.event === 'specific_column_changed' && s.columnId) config.column_id = s.columnId;
  if (s.event === 'subitem_column_changed' && s.subitemColumnId) config.column_id = s.subitemColumnId;
  if (s.event === 'subitem_status_changed') config.column_type = 'status';
  if (s.event === 'status_changed' || s.event === 'subitem_status_changed') {
    if (s.statusColumnId) config.column_id = s.statusColumnId;
    if (s.label) config.label = s.label;
  }
  if (def.needsGroup && s.groupId) config.group_id = s.groupId;
  if (def.needsChannel && s.channel?.trim()) config.channel = s.channel.trim();
  return config;
};

/** Everything an n8n HTTP error says about itself, as one text (NodeApiError wraps the API's error body). */
const errorText = (e: unknown): string => {
  const x = e as { message?: unknown; description?: unknown; httpCode?: unknown; context?: unknown; cause?: unknown };
  const cause = x?.cause as
    | { message?: unknown; status?: unknown; response?: { status?: unknown; data?: unknown; body?: unknown } }
    | undefined;
  return [
    x?.message,
    x?.description,
    x?.httpCode,
    x?.context,
    cause?.message,
    cause?.status,
    cause?.response?.status,
    cause?.response?.data,
    cause?.response?.body,
  ]
    .map((p) => {
      try {
        return typeof p === 'string' ? p : JSON.stringify(p);
      } catch {
        return '';
      }
    })
    .join(' ');
};
export const isNotFound = (e: unknown) =>
  (e as { httpCode?: unknown })?.httpCode === '404' || /\b404\b|not_found/.test(errorText(e));
export const challengeFailed = (e: unknown) => /webhook_challenge_failed/.test(errorText(e));

export function settingsOf(this: IHookFunctions): TriggerSettings {
  const options = this.getNodeParameter('options', {}) as IDataObject;
  const p = (name: string) => {
    try {
      return String(this.getNodeParameter(name, '') ?? '');
    } catch {
      return '';
    }
  };
  return {
    boardId: p('boardId'),
    event: p('event') as TriggerEvent,
    columnId: p('columnId'),
    subitemColumnId: p('subitemColumnId'),
    statusColumnId: p('statusColumnId'),
    label: p('label'),
    groupId: p('groupId'),
    channel: p('channel'),
    includeItem: options.includeItem !== false,
  };
}

export async function checkExists(this: IHookFunctions): Promise<boolean> {
  const state = this.getWorkflowStaticData('node') as HookState;
  if (!state.webhookId) return false;
  const url = this.getNodeWebhookUrl('default');
  try {
    const hook = (await apiRequest.call(
      this,
      'GET',
      `/webhooks/${encodeURIComponent(state.webhookId)}`,
    )) as IDataObject;
    // Still ours, on the same URL and event, and switched on — otherwise make a fresh one.
    if (hook.url === url && hook.event === apiEventOf(settingsOf.call(this).event) && hook.is_active !== false)
      return true;
    await apiRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(state.webhookId)}`).catch(() => undefined);
  } catch (e) {
    if (!isNotFound(e)) throw nodeError(this.getNode(), e);
  }
  delete state.webhookId;
  delete state.secret;
  return false;
}

export async function create(this: IHookFunctions): Promise<boolean> {
  const s = settingsOf.call(this);
  const url = this.getNodeWebhookUrl('default');
  if (!url) return false;
  const secret = newSecret();
  const workflow = this.getWorkflow();
  const body: IDataObject = {
    url,
    event: apiEventOf(s.event),
    config: configOf(s),
    secret,
    description: `n8n: ${workflow.name ?? workflow.id ?? 'workflow'}`.slice(0, 255),
  };
  const path = `/boards/${encodeURIComponent(s.boardId)}/webhooks`;
  let hook: IDataObject;
  try {
    // The platform first POSTs a challenge to the URL; the trigger answers it (see `webhook`).
    hook = (await apiRequest.call(this, 'POST', path, body)) as IDataObject;
  } catch (e) {
    // Where n8n cannot answer yet (the URL goes live only after activation), board owners may skip the handshake.
    if (!challengeFailed(e)) throw nodeError(this.getNode(), e);
    try {
      hook = (await apiRequest.call(this, 'POST', path, { ...body, skip_handshake: true })) as IDataObject;
    } catch {
      throw nodeError(this.getNode(), e);
    }
  }
  const state = this.getWorkflowStaticData('node') as HookState;
  state.webhookId = hook.id as string;
  state.secret = secret;
  state.url = url;
  state.event = s.event;
  return true;
}

export async function remove(this: IHookFunctions): Promise<boolean> {
  const state = this.getWorkflowStaticData('node') as HookState;
  if (state.webhookId) {
    try {
      await apiRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(state.webhookId)}`);
    } catch (e) {
      if (!isNotFound(e)) return false;
    }
  }
  delete state.webhookId;
  delete state.secret;
  delete state.url;
  delete state.event;
  return true;
}
