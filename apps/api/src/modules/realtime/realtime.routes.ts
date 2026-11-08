// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';
import { ACCOUNT_QUERY, STREAM_READY, STREAM_RESYNC, STREAM_REVOKED, type StreamEvent } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { errors } from '../../lib/openapi';
import type { BusEvent, EventBus } from '../../lib/realtime';
import type { AppDeps, AppEnv } from '../../types';
import { boardStream, meStream, type StreamFilter, toStreamEvent } from './realtime.service';
import { dashboardStream } from '../dashboards/dashboards.stream';

/**
 * Stream transport through Railway's edge (HTTP/2 to the browser). Its limits (docs.railway.com, public networking
 * → specs & limits): a request with no data for 5 minutes is closed, and **no HTTP request lives longer than 15
 * minutes** even with heartbeats (websockets are exempt; SSE is not). The edge cutting a stream mid-flight reaches the
 * browser as `net::ERR_HTTP2_PROTOCOL_ERROR` (prod, 2026-10-07); so does a deploy killing the process with streams
 * open. So:
 * - a `: ping` comment every 15s (well inside any idle timeout, and it keeps bytes moving through the proxy);
 * - every stream ends itself cleanly before the edge's cap ({@link MAX_STREAM_MS}); the browser's EventSource
 *   reconnects by itself with Last-Event-ID and the replay fills the gap (no event is lost);
 * - on shutdown (a deploy) every open stream is ended cleanly first ({@link closeAllStreams}).
 * Headers ({@link streamHeaders}): `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, no
 * Content-Length, no hop-by-hop headers, and no compression (middleware/compress.ts gzips application/json only;
 * hono's compress() runs on /assets/* only).
 */
export const HEARTBEAT_MS = 15_000;
/** A stream's lifetime: below Railway's 15-minute cap on any HTTP request. */
export const MAX_STREAM_MS = 10 * 60_000;
/** How long the browser waits before reconnecting after a clean end (the SSE `retry:` field). */
export const RECONNECT_MS = 1_000;

/**
 * hono's streamSSE sets `Cache-Control: no-cache` (dropping `no-transform`, which tells proxies not to buffer or
 * compress) and the HTTP/1-only `Connection: keep-alive` / `Transfer-Encoding: chunked`. Connection-specific headers
 * are forbidden in HTTP/2 (RFC 9113 §8.2.2) — a proxy that passes them on to the browser's HTTP/2 connection gets
 * `ERR_HTTP2_PROTOCOL_ERROR`. Node chunks a body without Content-Length by itself, so both go.
 */
export const streamHeaders = (res: Response) => {
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  res.headers.delete('Connection');
  res.headers.delete('Transfer-Encoding');
  res.headers.delete('Content-Length');
  return res;
};

/** Every open stream's clean stop — called on shutdown so a deploy never cuts a stream mid-flight. */
const openStreams = new Set<() => Promise<void>>();
export const closeAllStreams = async () => {
  await Promise.all([...openStreams].map((stop) => stop().catch(() => {})));
};

/** In-memory fan-out of committed events to the open streams of each account (one per API instance). */
const createHub = (bus: EventBus) => {
  const byAccount = new Map<string, Set<(e: BusEvent) => void>>();
  bus.subscribe((e) => byAccount.get(e.account_id)?.forEach((push) => push(e)));
  return {
    add: (accountId: string, push: (e: BusEvent) => void) => {
      const set = byAccount.get(accountId) ?? new Set();
      set.add(push);
      byAccount.set(accountId, set);
      return () => {
        set.delete(push);
        if (!set.size) byAccount.delete(accountId);
      };
    },
  };
};

const streamQuery = z.object({
  last_event_id: z
    .string()
    .optional()
    .openapi({ param: { name: 'last_event_id', in: 'query' }, description: 'Same as the Last-Event-ID header' }),
  [ACCOUNT_QUERY]: z
    .string()
    .optional()
    .openapi({ param: { name: ACCOUNT_QUERY, in: 'query' }, description: 'Account id (EventSource sends no headers)' }),
});

const streamResponse = {
  description:
    'text/event-stream: `id` = event id, `data` = StreamEvent JSON; `: ping` every 15s; a stream ends after 10 minutes (reconnect with Last-Event-ID)',
  content: { 'text/event-stream': { schema: z.string() } },
};

/** SSE (01 §4): the board channel and the personal channel. */
export const realtimeRoutes = (deps: AppDeps) => {
  const { db, bus, logger } = deps;
  const hub = createHub(bus);
  // The transport headers go on last (after hono has merged the context's headers into the response).
  const transport = createMiddleware<AppEnv>(async (c, next) => {
    await next();
    if (c.res.headers.get('content-type')?.startsWith('text/event-stream')) streamHeaders(c.res);
  });
  const scoped = [transport, requireAccount(deps, { query: true })];
  /**
   * Live events are queued from the moment of subscription, so nothing committed during the replay is lost;
   * each event is checked and written in order (one promise chain per connection).
   */
  const serve = (c: Context<AppEnv>, filter: StreamFilter) => {
    const accountId = c.get('account').accountId;
    // The browser resends Last-Event-ID itself; a reconnect we start by hand passes it as a query parameter.
    const lastId = c.req.header('last-event-id') ?? c.req.query('last_event_id');
    return streamSSE(c, async (stream) => {
      const endsAt = Date.now() + MAX_STREAM_MS;
      let open = true;
      let chain: Promise<void> = Promise.resolve();
      const write = (e: StreamEvent) => stream.writeSSE({ data: JSON.stringify(e), ...(e.id ? { id: e.id } : {}) });
      const stop = async (type?: string) => {
        if (!open) return;
        open = false;
        openStreams.delete(stop);
        unsubscribe();
        if (type) await write({ type }).catch(() => {});
        await stream.close();
      };
      const enqueue = (job: () => Promise<void>) => {
        chain = chain
          .then(() => (open ? job() : undefined))
          .catch((err) => {
            logger.warn({ err }, 'realtime: stream write failed');
            void stop();
          });
      };
      const deliver = (e: BusEvent) =>
        enqueue(async () => {
          const verdict = await filter.accept(e);
          if (verdict === 'close') return stop(STREAM_REVOKED);
          if (verdict === 'send') await write(toStreamEvent(filter.map ? filter.map(e) : e));
          // Fix: rows here that show something of the event's item (mirrors, relation names).
          if (filter.derive) for (const d of await filter.derive(e)) await write(toStreamEvent(d));
        });

      const unsubscribe = hub.add(accountId, deliver);
      openStreams.add(stop);
      stream.onAbort(() => {
        open = false;
        openStreams.delete(stop);
        unsubscribe();
      });

      enqueue(async () => {
        // `retry:` — after our clean end (lifetime, deploy) the browser comes back quickly.
        await stream.write(`retry: ${RECONNECT_MS}\n\n`);
        await write({ type: STREAM_READY });
        if (!lastId) return;
        const missed = await filter.replay(lastId);
        if (missed === STREAM_RESYNC) return void (await write({ type: STREAM_RESYNC }));
        for (const e of missed)
          if ((await filter.accept(e)) === 'send') await write(toStreamEvent(filter.map ? filter.map(e) : e));
      });

      while (open) {
        await stream.sleep(Math.min(HEARTBEAT_MS, Math.max(0, endsAt - Date.now())));
        if (!open) break;
        // Lifetime reached: end cleanly (after what is queued) — the browser reconnects with Last-Event-ID.
        if (Date.now() >= endsAt) {
          enqueue(() => stop());
          break;
        }
        enqueue(async () => {
          if (!(await filter.stillAllowed())) return stop(STREAM_REVOKED);
          await stream.write(': ping\n\n');
        });
      }
      await chain;
    });
  };

  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/events',
      tags: ['realtime'],
      summary: 'SSE: live events of a board and its sub-board (Last-Event-ID replays up to 24h)',
      middleware: scoped,
      request: {
        params: z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) }),
        query: streamQuery,
      },
      responses: { 200: streamResponse, ...errors(400, 401, 403, 404) },
    }),
    async (c) => serve(c, await boardStream(db, actorOf(c), c.req.valid('param').boardId)) as never,
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/dashboards/{dashboardId}/events',
      tags: ['realtime'],
      summary: 'SSE: a dashboard changed or one of its boards did — refetch the widgets (board id only)',
      middleware: scoped,
      request: {
        params: z.object({ dashboardId: z.string().openapi({ param: { name: 'dashboardId', in: 'path' } }) }),
        query: streamQuery,
      },
      responses: { 200: streamResponse, ...errors(400, 401, 403, 404) },
    }),
    async (c) => serve(c, await dashboardStream(db, actorOf(c), c.req.valid('param').dashboardId)) as never,
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/events',
      tags: ['realtime'],
      summary: 'SSE: events addressed to me in this account (notifications)',
      middleware: scoped,
      request: { query: streamQuery },
      responses: { 200: streamResponse, ...errors(400, 401, 403, 404) },
    }),
    async (c) => serve(c, meStream(db, actorOf(c))) as never,
  );

  return r;
};
