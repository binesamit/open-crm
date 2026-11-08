// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import { z } from 'zod';
import { updateSeenSchema } from '@bines/shared';
import type { Logger } from './logger';

/** The NOTIFY channel written by the activity_log / notifications triggers (migration 0009). */
export const EVENTS_CHANNEL = 'bines_events';

/** What a trigger announces: ids only — the hub decides who may hear it, the browser refetches. */
export const busEventSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  type: z.string(),
  board_id: z.string().nullable().optional(),
  item_id: z.string().nullable().optional(),
  column_id: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  actor_type: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
  /** Set on `notification.created`: the only user who hears it. */
  user_id: z.string().nullable().optional(),
  /** `update.seen` (r16seen): the update whose viewers changed, and its `seen` now (photos left out). */
  update_id: z.string().nullable().optional(),
  seen: updateSeenSchema.nullable().optional(),
});
export type BusEvent = z.infer<typeof busEventSchema>;

export type EventBus = {
  subscribe: (fn: (e: BusEvent) => void) => () => void;
  close: () => Promise<void>;
};

const fanOut = (logger: Logger) => {
  const listeners = new Set<(e: BusEvent) => void>();
  const emit = (raw: string) => {
    let parsed: BusEvent;
    try {
      parsed = busEventSchema.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err }, 'realtime: bad payload');
      return;
    }
    for (const fn of listeners) {
      try {
        fn(parsed);
      } catch (err) {
        logger.error({ err }, 'realtime: listener failed');
      }
    }
  };
  const subscribe = (fn: (e: BusEvent) => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  return { emit, subscribe };
};

/**
 * One dedicated LISTEN connection per API instance (D2: no Redis). Reconnects with backoff; events
 * committed while it was down are recovered by clients through Last-Event-ID.
 */
export const createPgBus = (connectionString: string, logger: Logger): EventBus => {
  const { emit, subscribe } = fanOut(logger);
  let client: pg.Client | null = null;
  let closed = false;
  let delay = 1000;

  const connect = async () => {
    if (closed) return;
    const c = new pg.Client({ connectionString });
    c.on('notification', (n) => n.channel === EVENTS_CHANNEL && n.payload && emit(n.payload));
    c.on('error', (err) => {
      logger.warn({ err }, 'realtime: LISTEN connection lost');
      void c.end().catch(() => {});
      if (client === c) retry();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${EVENTS_CHANNEL}`);
      client = c;
      delay = 1000;
    } catch (err) {
      logger.warn({ err }, 'realtime: LISTEN connect failed');
      void c.end().catch(() => {});
      retry();
    }
  };
  const retry = () => {
    client = null;
    if (closed) return;
    setTimeout(() => void connect(), delay).unref();
    delay = Math.min(delay * 2, 30_000);
  };
  void connect();

  return {
    subscribe,
    close: async () => {
      closed = true;
      await client?.end().catch(() => {});
    },
  };
};

/** Tests: PGlite delivers NOTIFY on commit just like Postgres. */
export const createListenBus = (
  listen: (channel: string, fn: (payload: string) => void) => Promise<() => Promise<void>>,
  logger: Logger,
): EventBus => {
  const { emit, subscribe } = fanOut(logger);
  const stop = listen(EVENTS_CHANNEL, emit);
  return { subscribe, close: async () => (await stop)() };
};

/** No realtime (scripts that build the app without a database listener). */
export const nullBus: EventBus = { subscribe: () => () => {}, close: async () => {} };
