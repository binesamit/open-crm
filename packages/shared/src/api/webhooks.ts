// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Outgoing board webhooks (06 §2.17, §4.3): a subscription to one event of a board, delivered signed
 * (HMAC-SHA256) with retries.
 */
export const WEBHOOK_EVENTS = [
  'item_created',
  'item_name_changed',
  'column_changed',
  'specific_column_changed',
  'status_changed',
  'item_moved_to_group',
  'item_moved_to_specific_group',
  'item_archived',
  'item_deleted',
  'item_restored',
  'item_moved_to_board',
  'subitem_created',
  'subitem_column_changed',
  'subitem_name_changed',
  'subitem_archived',
  'subitem_deleted',
  'update_created',
  'update_edited',
  'update_deleted',
  'subitem_update_created',
  'group_created',
  'column_created',
  /** D28: a column changed type (`previousColumnType` → `columnType`). */
  'column_type_changed',
  /** a file was added to a file column (`config.column_id` narrows it to one; `files` = the new ones). */
  'file_added',
  /**
   * Sent by an automation's "send to integrations" action (n8n, Make…) — never by an activity row. `config.channel`
   * narrows it to the actions that name that channel.
   */
  'automation_sent',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const normalizeWebhookEvent = (name: string): WebhookEvent | null =>
  (WEBHOOK_EVENTS as readonly string[]).includes(name) ? (name as WebhookEvent) : null;

/**
 * `{column_id}`, `{column_id, label}` (status: one label, by text) or `{group_id}`.
 * `subitem_column_changed` takes an optional `column_id` (a sub-board column), `column_type` and `label` too.
 */
export const webhookConfigSchema = z
  .object({
    column_id: z.string().optional(),
    label: z.string().optional(),
    group_id: z.string().optional(),
    /** subitem_column_changed: only columns of this type (e.g. `status`). */
    column_type: z.string().max(40).optional(),
    /** automation_sent: only the "send to integrations" actions with this channel (empty = every one). */
    channel: z.string().max(80).optional(),
    /** Include the item's cells in the payload (06 §4.3). */
    include_item: z.boolean().optional(),
    /**
     * `flat` (integrations without custom code, e.g. Make): the event also carries `deliveryId`, and the included
     * item `column_values` — each cell's text keyed by column title; the body also carries `timestamp` and
     * `signatureLite` (the `X-Bines-Signature-Lite` value) for tools that cannot read headers.
     */
    format: z.enum(['flat']).optional(),
  })
  .loose();
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/** What an activity row is, as webhook events (an item event on the sub-board is a subitem event). */
export type WebhookSource = {
  type: string;
  sub: boolean;
  column_key?: string | null;
  column_type?: string | null;
  /** status: the label text after the change. */
  label_after?: string;
  group_after?: string | null;
};

export const webhookEventsOf = (e: WebhookSource): WebhookEvent[] => {
  switch (e.type) {
    case 'item.created':
      return [e.sub ? 'subitem_created' : 'item_created'];
    case 'item.renamed':
      return [e.sub ? 'subitem_name_changed' : 'item_name_changed'];
    case 'cell.changed':
      if (e.sub) return ['subitem_column_changed'];
      return [
        'column_changed',
        'specific_column_changed',
        ...(e.column_type === 'status' ? (['status_changed'] as const) : []),
      ];
    case 'item.moved_to_group':
      return e.sub ? [] : ['item_moved_to_group', 'item_moved_to_specific_group'];
    case 'item.archived':
      return [e.sub ? 'subitem_archived' : 'item_archived'];
    case 'item.deleted':
      return [e.sub ? 'subitem_deleted' : 'item_deleted'];
    case 'item.restored':
    case 'item.unarchived':
      return e.sub ? [] : ['item_restored'];
    case 'item.moved_to_board':
      return ['item_moved_to_board'];
    case 'update.created':
      return [e.sub ? 'subitem_update_created' : 'update_created'];
    case 'update.edited':
      return ['update_edited'];
    case 'update.deleted':
      return ['update_deleted'];
    case 'group.created':
      return ['group_created'];
    case 'column.created':
      return ['column_created'];
    case 'column.type_changed':
      return e.sub ? [] : ['column_type_changed'];
    case 'file.added':
      return e.sub ? [] : ['file_added'];
    default:
      return [];
  }
};

/** Does a subscription want this event (its config narrows a column / label / group)? */
export const webhookWants = (sub: { event: WebhookEvent; config: WebhookConfig }, e: WebhookSource): boolean => {
  if (!webhookEventsOf(e).includes(sub.event)) return false;
  const c = sub.config;
  if (sub.event === 'specific_column_changed') return !!c.column_id && c.column_id === e.column_key;
  if (sub.event === 'status_changed')
    return (
      (!c.column_id || c.column_id === e.column_key) && (!c.label || c.label.trim() === (e.label_after ?? '').trim())
    );
  if (sub.event === 'item_moved_to_specific_group') return !!c.group_id && c.group_id === e.group_after;
  if (sub.event === 'file_added') return !c.column_id || c.column_id === e.column_key;
  // Subitems: `column_id` (a sub-board column), `column_type` and `label` (a status label, by text) narrow it.
  if (sub.event === 'subitem_column_changed')
    return (
      (!c.column_id || c.column_id === e.column_key) &&
      (!c.column_type || c.column_type === e.column_type) &&
      (!c.label?.trim() || (e.column_type === 'status' && c.label.trim() === (e.label_after ?? '').trim()))
    );
  return true;
};

/** Does an `automation_sent` subscription want a "send to integrations" action of this channel? */
export const webhookWantsChannel = (config: WebhookConfig, channel: string | null | undefined): boolean =>
  !config.channel?.trim() || config.channel.trim().toLocaleLowerCase() === (channel ?? '').trim().toLocaleLowerCase();

export const webhookSchema = z
  .object({
    id: z.string(),
    board_id: z.string(),
    url: z.string(),
    event: z.enum(WEBHOOK_EVENTS),
    config: webhookConfigSchema,
    description: z.string().nullable(),
    is_active: z.boolean(),
    verified: z.boolean(),
    disabled_reason: z.string().nullable(),
    failure_count: z.number().int(),
    /** Shown to whoever manages the board's webhooks (it signs the deliveries). */
    secret: z.string(),
    created_at: z.string(),
  })
  .meta({ id: 'Webhook' });
export type Webhook = z.infer<typeof webhookSchema>;

export const createWebhookSchema = z.object({
  url: z.url().max(1000),
  /** One of WEBHOOK_EVENTS. */
  event: z.string().min(1).max(64),
  config: webhookConfigSchema.optional(),
  description: z.string().max(255).optional(),
  secret: z.string().min(16).max(128).optional(),
  /** Admins: register without the challenge (Zapier cannot echo it) — stored as unverified. */
  skip_handshake: z.boolean().optional(),
});

export const updateWebhookSchema = z.object({
  url: z.url().max(1000).optional(),
  config: webhookConfigSchema.optional(),
  description: z.string().max(255).nullable().optional(),
  active: z.boolean().optional(),
  skip_handshake: z.boolean().optional(),
});

export const webhookDeliverySchema = z
  .object({
    id: z.string(),
    webhook_id: z.string().nullable(),
    automation_id: z.string().nullable(),
    event_id: z.string(),
    event_type: z.string().nullable(),
    status: z.enum(['pending', 'delivered', 'failed', 'dead']),
    attempt: z.number().int(),
    response_status: z.number().int().nullable(),
    response_ms: z.number().int().nullable(),
    error: z.string().nullable(),
    next_attempt_at: z.string().nullable(),
    delivered_at: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'WebhookDelivery' });
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

/** Retry schedule after a failed attempt (06 §2.17): 6 retries, then dead. */
export const WEBHOOK_RETRY_MINUTES = [1, 5, 30, 120, 360, 1440] as const;
export const WEBHOOK_DISABLE_AFTER_DEAD = 50;
