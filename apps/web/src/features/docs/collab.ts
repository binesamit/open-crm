// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useSyncExternalStore } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { GROUP_COLORS, GROUP_PALETTE } from '@bines/shared';

/**
 * One live session per open doc (M8 ד1): a Yjs doc + a Hocuspocus provider on `/api/v1/collab` (same origin — the
 * session cookie authenticates). Kept outside React so StrictMode's double mount and quick re-renders reuse it;
 * the last listener leaving closes it after a short grace.
 */
export const COLLAB_PATH = '/api/v1/collab';

export type CollabView = {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** The server sent the doc (first sync done). */
  synced: boolean;
  /** The socket is open. */
  connected: boolean;
  /** The server lets me only read (viewer / commenter). Null until authenticated. */
  readOnly: boolean | null;
  /** Refused (no access any more, signed out): the reason. */
  failed: string | null;
  /** Others in the doc now (awareness), without me — one row per person (their tabs merged). */
  peers: CollabPeer[];
  /** Local changes not yet acknowledged by the server. */
  unsynced: number;
  /** The latest comment change someone in the doc announced (ד3): the comments refetch when it moves. */
  commentsNudge: number;
  /**
   * The server closed the connection (S-92): `too_large` — the doc reached its maximum size, the last change was
   * not saved, no reconnecting (read-only); `too_fast` — too many messages, reconnecting after a pause.
   */
  closed: CollabClosed | null;
};

export type CollabClosed = 'too_large' | 'too_fast';

/** Someone else in the doc: where their caret is (a block id) and whether they are typing now. */
export type CollabPeer = {
  clientId: number;
  name: string;
  color: string;
  userId: string | null;
  block: string | null;
  typing: boolean;
};

/**
 * The others in the doc from the awareness states: me (this tab) left out, and one person's several tabs merged
 * into one row — typing in any of them counts, the block is the typing tab's (else any tab's that has one).
 */
export const peersOf = (states: Iterable<[number, Record<string, unknown>]>, myClientId: number): CollabPeer[] => {
  const byPerson = new Map<string, CollabPeer>();
  for (const [clientId, s] of states) {
    if (clientId === myClientId) continue;
    const user = s.user as { name?: string; color?: string; id?: string } | undefined;
    if (!user?.name) continue;
    const peer: CollabPeer = {
      clientId,
      name: user.name,
      color: user.color ?? GROUP_COLORS.blue,
      userId: typeof user.id === 'string' ? user.id : null,
      block: typeof s.block === 'string' ? s.block : null,
      typing: s.typing === true,
    };
    const key = peer.userId ?? `client:${clientId}`;
    const had = byPerson.get(key);
    if (!had) byPerson.set(key, peer);
    else
      byPerson.set(key, {
        ...had,
        block: peer.typing ? (peer.block ?? had.block) : (had.block ?? peer.block),
        typing: had.typing || peer.typing,
      });
  }
  return [...byPerson.values()];
};
/** The server's close codes (apps/api docs/collab.ts, S-92). */
export const COLLAB_CLOSE_TOO_LARGE = 4413;
export const COLLAB_CLOSE_TOO_FAST = 4429;
/** After `too_fast`: reconnect after this long. */
export const COLLAB_RETRY_AFTER_MS = 10_000;

/** What a close code means for the editor (null: a normal close — the provider reconnects by itself). */
export const collabClosed = (code: number | undefined): CollabClosed | null =>
  code === COLLAB_CLOSE_TOO_LARGE ? 'too_large' : code === COLLAB_CLOSE_TOO_FAST ? 'too_fast' : null;

/**
 * Reacts to a close (S-92). Runs before the provider schedules its own reconnect, so `stopReconnect` wins:
 * `too_large` stops for good and leaves the doc readable (read-only); `too_fast` pauses, then reconnects.
 */
export const onCollabClose = (
  code: number | undefined,
  ctl: {
    stopReconnect: () => void;
    reconnect: () => void;
    set: (patch: Partial<CollabView>) => void;
    later: (fn: () => void, ms: number) => void;
  },
) => {
  const closed = collabClosed(code);
  if (!closed) return;
  ctl.stopReconnect();
  if (closed === 'too_large') {
    ctl.set({ closed, readOnly: true });
    return;
  }
  ctl.set({ closed });
  ctl.later(ctl.reconnect, COLLAB_RETRY_AFTER_MS);
};

type Session = { view: CollabView; listeners: Set<() => void>; refs: number; closeTimer: ReturnType<typeof setTimeout> | null };
const sessions = new Map<string, Session>();

export const collabUrl = () => {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${COLLAB_PATH}`;
};

const open = (name: string): Session => {
  const doc = new Y.Doc();
  let closed: CollabClosed | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  // `onClose` in the provider's own configuration is heard by its socket before the socket schedules a reconnect.
  const provider: HocuspocusProvider = new HocuspocusProvider({
    url: collabUrl(),
    name,
    document: doc,
    token: 'session',
    onClose: ({ event }: { event: { code?: number } }) => {
      if (closed === 'too_large') return;
      onCollabClose(event?.code, {
        stopReconnect: () => {
          provider.configuration.websocketProvider.shouldConnect = false;
        },
        reconnect: () => void provider.connect(),
        set,
        later: (fn, ms) => {
          if (retry) clearTimeout(retry);
          retry = setTimeout(() => {
            retry = null;
            fn();
          }, ms);
        },
      });
    },
  });
  provider.on('destroy', () => {
    if (retry) clearTimeout(retry);
  });
  const session: Session = {
    view: {
      doc,
      provider,
      synced: false,
      connected: false,
      readOnly: null,
      failed: null,
      peers: [],
      unsynced: 0,
      commentsNudge: 0,
      closed: null,
    },
    listeners: new Set(),
    refs: 0,
    closeTimer: null,
  };
  function set(patch: Partial<CollabView>) {
    if (patch.closed !== undefined) closed = patch.closed;
    session.view = { ...session.view, ...patch };
    session.listeners.forEach((l) => l());
  }
  const peers = () => peersOf(provider.awareness?.getStates().entries() ?? [], doc.clientID);
  provider.on('synced', ({ state }: { state: boolean }) => set({ synced: state }));
  provider.on('status', ({ status }: { status: string }) =>
    set({ connected: status === 'connected', ...(status === 'connected' && closed === 'too_fast' ? { closed: null } : {}) }),
  );
  // After `too_large` the doc stays read-only whatever a late message says.
  provider.on('authenticated', ({ scope }: { scope: string }) =>
    set({ readOnly: scope === 'readonly' || closed === 'too_large', failed: null }),
  );
  provider.on('authenticationFailed', ({ reason }: { reason: string }) => set({ failed: reason || 'denied' }));
  provider.on('unsyncedChanges', ({ number }: { number: number }) => set({ unsynced: number }));
  // Others' comment changes travel as an awareness field (read-only connections may send awareness too).
  const nudge = () =>
    Math.max(
      0,
      ...[...(provider.awareness?.getStates().entries() ?? [])]
        .filter(([id]) => id !== doc.clientID)
        .map(([, s]) => Number((s as { comments?: number }).comments) || 0),
    );
  provider.on('awarenessChange', () => set({ peers: peers(), commentsNudge: nudge() }));
  return session;
};

const acquire = (name: string) => {
  let s = sessions.get(name);
  if (!s) {
    s = open(name);
    sessions.set(name, s);
  }
  if (s.closeTimer) clearTimeout(s.closeTimer);
  s.closeTimer = null;
  s.refs++;
  return s;
};

const release = (name: string) => {
  const s = sessions.get(name);
  if (!s) return;
  s.refs--;
  if (s.refs > 0) return;
  // A remount (StrictMode, a quick navigation back) within the grace keeps the connection.
  s.closeTimer = setTimeout(() => {
    if (s.refs > 0) return;
    sessions.delete(name);
    s.view.provider.destroy();
    s.view.doc.destroy();
  }, 1500);
};

/** The live session of a doc (null on the very first render, before it is opened). */
export const useCollab = (name: string): CollabView | null => {
  const subscribe = useCallback(
    (cb: () => void) => {
      const s = acquire(name);
      s.listeners.add(cb);
      cb();
      return () => {
        s.listeners.delete(cb);
        release(name);
      };
    },
    [name],
  );
  return useSyncExternalStore(subscribe, () => sessions.get(name)?.view ?? null);
};

/** A stable caret colour per person: our group palette (real hex — the editor's cursor styles need a colour). */
const CARET_COLORS = GROUP_PALETTE.slice(0, 10).map((k) => GROUP_COLORS[k]);
export const caretColor = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CARET_COLORS[h % CARET_COLORS.length]!;
};
