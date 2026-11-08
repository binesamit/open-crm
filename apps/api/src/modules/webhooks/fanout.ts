// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import {
  columnTypes,
  columnValuesOf,
  newId,
  webhookConfigSchema,
  webhookEventsOf,
  webhookWants,
  webhookWantsChannel,
  type WebhookEvent,
  type WebhookSource,
} from '@bines/shared';
import { cells, columns, groups, items, users, webhookDeliveries, webhooks } from '../../db/schema';
import type { AppDeps } from '../../types';
import type { ActivityRow } from '../activity/activity.repo';
import type { BoardRow } from '../boards/boards.repo';
import { queueDelivery } from './delivery';

/**
 * Board webhooks (06 §2.17): one activity row → a delivery for every active subscription of the board that
 * wants it (an event on the sub-board reaches the parent board's `subitem_*` subscriptions). The payload
 * (06 §4.3) is our `event` object — built now, so a retry sends what happened then.
 */
type Label = { id: number; label: string };

const textOf = (col: typeof columns.$inferSelect | undefined, value: unknown) => {
  const def = col && columnTypes.get(col.type);
  if (!def || value === null || value === undefined) return '';
  try {
    return def.toText(value, { ...(def.defaultSettings as object), ...(col!.settings as object) }, {});
  } catch {
    return '';
  }
};

const valueOf = (x: unknown) =>
  x && typeof x === 'object' && 'value' in x ? (x as { value: unknown }).value : undefined;

export const fanoutWebhooks = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  row: ActivityRow,
  own: BoardRow,
): Promise<string[]> => {
  const { db } = deps;
  const sub = !!own.parentBoardId;
  const boardId = own.parentBoardId ?? own.id;
  const meta = (row.payload.meta ?? {}) as Record<string, unknown>;
  const columnKey = (meta.column_key as string | undefined) ?? null;
  const columnType = (meta.column_type as string | undefined) ?? null;
  const base: WebhookSource = { type: row.type, sub, column_key: columnKey, column_type: columnType };
  if (!webhookEventsOf(base).length) return [];

  const subs = await db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.accountId, row.accountId),
        eq(webhooks.boardId, boardId),
        eq(webhooks.isActive, true),
        isNull(webhooks.deletedAt),
      ),
    );
  if (!subs.length) return [];

  const col = columnKey
    ? (
        await db
          .select()
          .from(columns)
          .where(and(eq(columns.boardId, own.id), eq(columns.key, columnKey)))
          .limit(1)
      )[0]
    : undefined;
  const after = valueOf(row.payload.after);
  const before = valueOf(row.payload.before);
  const labels = ((col?.settings as { labels?: Label[] } | undefined)?.labels ?? []) as Label[];
  const labelText = (v: unknown) => labels.find((l) => l.id === (v as { index?: number } | null)?.index)?.label ?? '';
  const groupAfter = (row.payload.after as { group_id?: string } | undefined)?.group_id ?? null;
  const source: WebhookSource = {
    ...base,
    label_after: columnType === 'status' ? labelText(after) : undefined,
    group_after: groupAfter,
  };

  const wanted = subs.flatMap((s) => {
    const config = webhookConfigSchema.parse(s.config ?? {});
    return webhookWants({ event: s.eventType as WebhookEvent, config }, source) ? [{ s, config }] : [];
  });
  if (!wanted.length) return [];

  const item = row.itemId ? (await db.select().from(items).where(eq(items.id, row.itemId)).limit(1))[0] : undefined;
  const group = item?.groupId
    ? (await db.select().from(groups).where(eq(groups.id, item.groupId)).limit(1))[0]
    : undefined;
  const actor = row.actorId
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, row.actorId)).limit(1))[0]
    : undefined;
  const automation = meta.automation as { run_id?: string } | undefined;
  const itemName = item?.name ?? (row.payload.before as { name?: string } | undefined)?.name ?? null;
  const value = (v: unknown) =>
    v === undefined
      ? undefined
      : v === null
        ? null
        : { ...(typeof v === 'object' ? (v as object) : { value: v }), text: textOf(col, v) };

  // `include_item`: the item with its stored cells, keyed by column id (computed columns are left out).
  let snapshot: Record<string, unknown> | undefined;
  const snapshotOf = async (it: typeof items.$inferSelect) => (snapshot ??= await itemSnapshot(deps, it));

  const ids: string[] = [];
  for (const { s, config } of wanted) {
    // A redelivered dispatch job does not send twice.
    const dup = (
      await db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.webhookId, s.id), eq(webhookDeliveries.eventId, row.id)))
        .limit(1)
    )[0];
    if (dup) continue;
    const event = s.eventType as WebhookEvent;
    const payload = {
      event: {
        type: event,
        originalTriggerUuid: automation?.run_id ?? null,
        triggerTime: new Date().toISOString(),
        subscriptionId: s.id,
        accountId: row.accountId,
        userId: row.actorType === 'automation' ? `automation:${row.automationId}` : row.actorId,
        actor: { kind: row.actorType, id: row.actorId, name: actor?.name ?? null },
        boardId,
        boardName: own.parentBoardId ? null : own.name,
        groupId: item?.groupId ?? null,
        groupName: group?.title ?? null,
        itemId: row.itemId,
        itemName,
        parentItemId: item?.parentItemId ?? null,
        parentItemBoardId: sub ? boardId : null,
        ...(columnKey
          ? {
              columnId: columnKey,
              columnType,
              columnTitle: col?.title ?? null,
              value: value(after),
              previousValue: value(before),
            }
          : {}),
        ...(row.type === 'item.moved_to_group'
          ? {
              sourceGroupId: (row.payload.before as { group_id?: string } | undefined)?.group_id ?? null,
              destGroupId: groupAfter,
            }
          : {}),
        // D28: a column changed type.
        ...(row.type === 'column.type_changed'
          ? {
              previousColumnType: (meta.from_type as string | undefined) ?? null,
              conversionId: (meta.conversion_id as string | undefined) ?? null,
            }
          : {}),
        // the files just added (id, name, size, type — a link is asked for with the file's id).
        ...(row.type === 'file.added'
          ? { files: (row.payload.after as { files?: unknown[] } | undefined)?.files ?? [] }
          : {}),
        ...(row.type.startsWith('update.')
          ? { updateId: (row.payload.after as { update_id?: string } | undefined)?.update_id ?? null }
          : {}),
        changedAt: row.createdAt.toISOString(),
        app: 'bines-os',
        eventId: row.id,
        batchId: row.batchId,
        ...(config.include_item && item ? { item: await snapshotOf(item) } : {}),
      },
    };
    const flat = config.format === 'flat';
    ids.push(
      await queueDelivery(
        deps,
        {
          accountId: row.accountId,
          webhookId: s.id,
          eventId: row.id,
          eventType: event,
          requestBody: flat ? { event: await flatEvent(deps, payload.event) } : payload,
        },
        { stampDeliveryId: flat },
      ),
    );
  }
  return ids;
};

/**
 * A `flat` subscription's event (integrations without custom code, e.g. Make): the included item also carries
 * `column_values` — each cell's text keyed by column title. (`deliveryId` is stamped when the delivery is queued.)
 */
export const flatEvent = async <E extends { item?: unknown }>(deps: Pick<AppDeps, 'db'>, event: E): Promise<E> => {
  const item = event.item as { board_id?: string; cells?: Record<string, { text?: string | null } | null> } | null;
  if (!item || typeof item !== 'object' || !item.board_id) return event;
  const titles = new Map(
    (
      await deps.db
        .select({ key: columns.key, title: columns.title })
        .from(columns)
        .where(and(eq(columns.boardId, item.board_id), isNull(columns.deletedAt)))
    ).map((c) => [c.key, c.title]),
  );
  return { ...event, item: { ...item, column_values: columnValuesOf(item.cells ?? {}, titles) } };
};

/** An item as an integration reads it: its fields and stored cells (`{value, text}` keyed by column id). */
export const itemSnapshot = async (
  deps: Pick<AppDeps, 'db'>,
  item: typeof items.$inferSelect,
): Promise<Record<string, unknown>> => {
  const rows = await deps.db
    .select({ key: columns.key, value: cells.value, text: cells.textValue })
    .from(cells)
    .innerJoin(columns, eq(columns.id, cells.columnId))
    .where(and(eq(cells.itemId, item.id), isNull(columns.deletedAt)));
  return {
    id: item.id,
    name: item.name,
    board_id: item.boardId,
    group_id: item.groupId,
    parent_item_id: item.parentItemId,
    cells: Object.fromEntries(rows.map((r) => [r.key, { value: r.value, text: r.text }])),
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
};

/**
 * An automation's "send to integrations" action: one signed delivery to every active `automation_sent` subscription
 * of the board whose channel matches. Returns the delivery ids (none = nobody listens).
 */
export const fanoutAutomationSent = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  input: {
    accountId: string;
    boardId: string;
    boardName: string | null;
    channel: string | null;
    automationId: string;
    runId: string;
    actionIndex: number;
    actor: { kind: string; id: string | null };
    item: Record<string, unknown> | null;
  },
): Promise<string[]> => {
  const subs = await deps.db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.accountId, input.accountId),
        eq(webhooks.boardId, input.boardId),
        eq(webhooks.eventType, 'automation_sent'),
        eq(webhooks.isActive, true),
        isNull(webhooks.deletedAt),
      ),
    );
  const ids: string[] = [];
  for (const s of subs) {
    const config = webhookConfigSchema.parse(s.config ?? {});
    if (!webhookWantsChannel(config, input.channel)) continue;
    const flat = config.format === 'flat';
    const eventId = newId();
    const item = input.item as { id?: string; name?: string; group_id?: string | null } | null;
    const automationEvent = {
      type: 'automation_sent',
      channel: input.channel,
      triggerTime: new Date().toISOString(),
      subscriptionId: s.id,
      accountId: input.accountId,
      actor: input.actor,
      automationId: input.automationId,
      originalTriggerUuid: input.runId,
      boardId: input.boardId,
      boardName: input.boardName,
      groupId: item?.group_id ?? null,
      itemId: item?.id ?? null,
      itemName: item?.name ?? null,
      item: input.item,
      app: 'bines-os',
      eventId,
    };
    ids.push(
      await queueDelivery(
        deps,
        {
          accountId: input.accountId,
          webhookId: s.id,
          automationId: input.automationId,
          actionIndex: input.actionIndex,
          eventId,
          eventType: 'automation_sent',
          requestBody: { event: flat ? await flatEvent(deps, automationEvent) : automationEvent },
        },
        { stampDeliveryId: flat },
      ),
    );
  }
  return ids;
};
