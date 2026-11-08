// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { ACCOUNT_QUERY, STREAM_READY, STREAM_REVOKED, type StreamEvent } from '@bines/shared';

/** Every API call of this tab carries `<tab>-<n>` as X-Request-Id; the events it causes come back with it. */
const TAB_ID = `tab_${Math.random().toString(36).slice(2, 12)}`;
let seq = 0;
export const nextRequestId = () => `${TAB_ID}-${++seq}`;

/** This tab already updated its cache for its own writes — their echo needs no refetch. */
export const fromThisTab = (e: StreamEvent) => !!e.request_id?.startsWith(`${TAB_ID}-`);

const MAX_DELAY = 30_000;

type Listener = (e: StreamEvent) => void;
type Channel = { listeners: Set<Listener>; ready: boolean; stop: () => void };

/**
 * One EventSource per channel (path + account) however many components listen — the bell, the Inbox badge
 * and a page on /me/events share it (browsers allow few connections per site). On a network drop the
 * browser reconnects by itself and resends Last-Event-ID; when it gives up (an HTTP error, a server
 * restart) we reopen with backoff 1s→30s and pass the last id ourselves. `revoked` ends the channel.
 */
const channels = new Map<string, Channel>();

const openChannel = (path: string, accountId: string, ch: Omit<Channel, 'stop'>, onRevoked: () => void) => {
  let source: EventSource | null = null;
  let lastId: string | undefined;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => {
    const params = new URLSearchParams({ [ACCOUNT_QUERY]: accountId });
    if (lastId) params.set('last_event_id', lastId);
    const es = new EventSource(`/api/v1${path}?${params}`);
    source = es;
    es.onmessage = (m: MessageEvent<string>) => {
      delay = 1000;
      if (m.lastEventId) lastId = m.lastEventId;
      let e: StreamEvent;
      try {
        e = JSON.parse(m.data) as StreamEvent;
      } catch {
        return;
      }
      if (e.type === STREAM_READY) ch.ready = true;
      if (e.type === STREAM_REVOKED) {
        stopped = true;
        ch.ready = false;
        es.close();
        // The channel is dead for good: leave the registry, so the next subscriber to this path opens a fresh one
        // (access re-granted) instead of finding this one while any old listener is still attached (web #6).
        onRevoked();
      }
      for (const fn of [...ch.listeners]) fn(e);
    };
    es.onerror = () => {
      ch.ready = false;
      if (stopped || es.readyState !== EventSource.CLOSED) return; // CONNECTING: the browser is retrying
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
};

const subscribe = (path: string, accountId: string, fn: Listener) => {
  const key = `${accountId} ${path}`;
  let ch = channels.get(key);
  if (!ch) {
    const state = { listeners: new Set<Listener>(), ready: false };
    const mine: Channel = Object.assign(state, { stop: () => undefined });
    mine.stop = openChannel(path, accountId, state, () => {
      if (channels.get(key) === mine) channels.delete(key);
    });
    ch = mine;
    channels.set(key, ch);
  }
  ch.listeners.add(fn);
  // A late joiner missed `ready`; if the channel is already open, tell it (the board page shows `data-live`) —
  // marked `late`: the stream did not (re)connect, so nothing was missed.
  if (ch.ready) fn({ type: STREAM_READY, late: true });
  return () => {
    ch.listeners.delete(fn);
    if (!ch.listeners.size) {
      ch.stop();
      // Only this channel — a revoked one already left, and a newer one may sit under the same key.
      if (channels.get(key) === ch) channels.delete(key);
    }
  };
};

/** Listen on an SSE channel (01 §4) for as long as the component is mounted. */
export const useEventStream = (path: string | null, accountId: string, onEvent: (e: StreamEvent) => void) => {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!path) return;
    return subscribe(path, accountId, (e) => handler.current(e));
  }, [path, accountId]);
};

/**
 * r25: listen on several SSE channels at once (one per path, shared with every other listener of that path) — the
 * relation marks follow each linked board. Paths are compared by value: a new array of the same paths keeps the
 * subscriptions.
 */
export const useEventStreams = (paths: string[], accountId: string, onEvent: (e: StreamEvent) => void) => {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  const key = [...new Set(paths)].sort().join('\n');
  useEffect(() => {
    if (!key) return;
    const stops = key.split('\n').map((path) => subscribe(path, accountId, (e) => handler.current(e)));
    return () => stops.forEach((stop) => stop());
  }, [key, accountId]);
};
