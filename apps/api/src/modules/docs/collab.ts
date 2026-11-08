// SPDX-License-Identifier: AGPL-3.0-only
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Hocuspocus,
  IncomingMessage as HocuspocusMessage,
  MessageType,
  type Connection,
  type Document,
} from '@hocuspocus/server';
import crossws from 'crossws/adapters/node';
import * as Y from 'yjs';
import { canDoc, DOC_STATE_MAX_BYTES, docMentionIds, isId, type RichNode } from '@bines/shared';
import { accountClosed, hasFeature } from '../billing/entitlements';
import type { AccountContext, AppDeps, SessionUser, SupportAccess } from '../../types';
import { clientIpConfig, RESOLVED_IP_HEADER, resolveClientIp } from '../../lib/client-ip';
import { assertTwoFactorGate, cachedSecurity } from '../admin/two-factor.service';
import { assertSsoGate } from '../admin/sso-policy';
import { findAccountById } from '../accounts/accounts.repo';
import {
  auditSupportRequest,
  ipAllowedFor,
  resolveAccountAccess,
  touchSupportSession,
} from '../support/support.access';
import { findEvent, recordEvent } from '../activity/activity.repo';
import { loadDocAccess } from './docs.access';
import { notifyDoc } from './docs.notify';
import { findDoc, lastDocVersionAt, loadDocContent, loadDocState, storeDocState } from './docs.repo';
import { collabName, verifyCollabToken } from './docs.service';
import {
  AUTO_VERSION_EVERY_MS,
  replaceFragment,
  setLiveDocReader,
  setLiveDocWriter,
  snapshotDoc,
} from './docs.versions';
import { deriveDoc, encodeState, jsonToYdoc } from './ydoc';
import { findUserById } from '../users/users.repo';

/**
 * Live co-editing of docs (M8 ד1, plan §3.3): a Hocuspocus (Yjs) server inside the api process, on the same HTTP
 * server and origin — `GET /api/v1/collab` upgrades to a WebSocket, the session cookie authenticates it.
 *
 * - Document name `<account_id>:<doc_id>`; per document `onAuthenticate` checks the account membership and the
 *   doc's permissions — a doc one cannot read is refused, a viewer / commenter connects read-only.
 * - The Yjs state is the truth (`docs.ydoc`); every save (debounced 2 s, at most 10 s) also derives the
 *   ProseMirror JSON, the search text and the files it shows.
 * - Activity: one `doc.edited` per person and doc every ~10 minutes of editing, not per keystroke.
 * - Access changes (members, kind, workspace, trash) reach every API process through the event bus: the doc's
 *   connections are closed and the clients reconnect — and are checked again.
 * - Same gates as `requireAccount` (S-24): the account's IP allowlist and two-factor requirement; open connections
 *   are checked again every COLLAB_RECHECK_MS (and on board / workspace / team / account events) — a deactivated or
 *   demoted member, a revoked session, an address taken off the allowlist lose the socket.
 * - A WebSocket message is at most COLLAB_MAX_MESSAGE_BYTES (S-24).
 * - A document is at most DOC_STATE_MAX_BYTES (S-92): its size is tracked from load and every applied change; an
 *   edit that would take it past the cap is refused and the socket closed with 4413 — a state above the cap is never
 *   saved nor snapshotted. Each connection may send at most COLLAB_MESSAGE_RATE messages per window (4429 beyond).
 *
 * Known limit: a doc lives in the memory of one process. Two clients on one doc must reach the same process — true
 * with one api instance and WEB_CONCURRENCY=1 (today). Before scaling out: a separate `collab` service with one
 * instance, or a cross-instance sync over pg_notify (D25).
 */
export const COLLAB_PATH = '/api/v1/collab';
/** One `doc.edited` per person and doc at most this often. */
export const DOC_EDITED_EVERY_MS = 10 * 60_000;
/** Events after which a doc's connections must be checked again. */
const ACCESS_EVENTS = new Set(['doc.members_changed', 'doc.updated', 'doc.moved', 'doc.deleted']);
/** Events after which every open connection of the account is checked again (S-24). */
const ACCOUNT_ACCESS_EVENT = /^(board|workspace|team|account)\./;
/** Open connections are checked again this often (S-24). */
export const COLLAB_RECHECK_MS = 30_000;
/** The largest WebSocket message (S-24; the `ws` default is 100 MiB): twice the largest doc state. */
export const COLLAB_MAX_MESSAGE_BYTES = 2 * DOC_STATE_MAX_BYTES;
/** S-92: at most this many messages per connection per window (typing + presence is a few a second). */
export const COLLAB_MESSAGE_RATE = { max: 600, windowMs: 10_000 };
/** Close codes (S-92): the document would grow past its cap / the connection sends too fast. */
export const COLLAB_CLOSE_TOO_LARGE = 4413;
export const COLLAB_CLOSE_TOO_FAST = 4429;
/** y-protocols sync message kinds that carry document content (step 2, update); step 1 is a state vector. */
const SYNC_CONTENT_KINDS = new Set([1, 2]);

export type CollabContext = {
  userId: string;
  accountId: string;
  docId: string;
  name: string;
  readOnly: boolean;
  /** The client address of the upgrade (trusted-proxy rules, S-10) — the account's IP allowlist (S-24). */
  ip?: string | null;
  /** The session cookie it connected with (server side only) — the session is checked again while it stays open. */
  cookie?: string;
  /** In the account by remote support access: a view grant connects read-only. */
  support?: SupportAccess | null;
};

const parseName = (documentName: string) => {
  const [accountId, docId, extra] = documentName.split(':');
  return accountId && docId && extra === undefined && isId(accountId) && isId(docId) ? { accountId, docId } : null;
};

export type CollabOptions = {
  debounce?: number;
  maxDebounce?: number;
  now?: () => number;
  recheckMs?: number;
  /** The document size cap (S-92; default DOC_STATE_MAX_BYTES). */
  maxDocBytes?: number;
  /** Messages per connection per window (S-92; default COLLAB_MESSAGE_RATE). */
  messageRate?: { max: number; windowMs: number };
};

/** A refusal Hocuspocus turns into closing the connection with this code. */
const closeWith = (code: number, reason: string) => Object.assign(new Error(reason), { code, reason });

/** Does this raw message (document name, type, …) carry document content — a sync step 2 or an update? */
const carriesContent = (raw: Uint8Array) => {
  try {
    const message = new HocuspocusMessage(raw);
    message.readVarString(); // the document name
    const type = message.readVarUint();
    if (type !== MessageType.Sync && type !== MessageType.SyncReply) return false;
    return SYNC_CONTENT_KINDS.has(message.readVarUint());
  } catch {
    return true; // unreadable → counted, Hocuspocus refuses it anyway
  }
};

export const createCollab = (deps: AppDeps, opts: CollabOptions = {}) => {
  const { db, logger, env, auth, bus } = deps;
  const now = opts.now ?? Date.now;
  const maxDocBytes = opts.maxDocBytes ?? DOC_STATE_MAX_BYTES;
  const messageRate = opts.messageRate ?? COLLAB_MESSAGE_RATE;
  /**
   * Document name → its size in bytes (S-92): the state on load, plus every change applied since; set back to the
   * real state size at each save. An upper bound (merged updates take less), so the cap is never passed.
   */
  const docBytes = new Map<string, number>();
  /** Connection → messages in the current window (S-92). */
  const rates = new WeakMap<object, { start: number; count: number }>();
  /** Closes the socket itself (the provider sees the code); Hocuspocus then ends the connection. */
  const closeSocket = (connection: Connection<CollabContext>, code: number, reason: string) => {
    const socket = (connection as unknown as { webSocket?: { close?: (code: number, reason: string) => void } })
      .webSocket;
    try {
      socket?.close?.(code, reason);
    } catch {
      /* already closing */
    }
  };
  /** `<doc>:<user>` → when the last `doc.edited` was recorded (this process; a restart may record one more). */
  const lastEdited = new Map<string, number>();
  /** Document name → who changed it since its last save. */
  const editors = new Map<string, Set<string>>();
  /** Documents edited since their last version (an automatic one is taken when the last editor leaves). */
  const dirty = new Set<string>();
  /** Documents a version restore is writing into now. */
  const restoring = new Set<string>();

  /** The person behind a session cookie (null: no valid session). */
  const sessionOf = async (
    headers: Headers,
  ): Promise<{ userId: string; signInMethod: string | null; signInOrg: string | null } | null> => {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) return null;
    const s = session?.session as { signInMethod?: string | null; signInOrg?: string | null } | undefined;
    return { userId, signInMethod: s?.signInMethod ?? null, signInOrg: s?.signInOrg ?? null };
  };

  /**
   * May this person use this doc now, and how — the gates of `requireAccount` (S-24): an active membership of an
   * account that is not suspended, the account's IP allowlist (the platform owner excepted, as there) and its
   * two-factor requirement; then the doc's own permissions. Throws when refused.
   */
  const authorize = async (
    name: { accountId: string; docId: string },
    userId: string,
    ip: string | null,
    /** A cookie session: how it was signed in (S-71 — the account's SSO policy). A collab token passed it when minted. */
    session?: { signInMethod: string | null; signInOrg?: string | null },
  ): Promise<Omit<CollabContext, 'ip' | 'cookie'> & { user: SessionUser }> => {
    const row = await findUserById(db, userId);
    if (!row || row.isService) throw new Error('unauthenticated');
    const user: SessionUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: row.emailVerified,
      isPlatformOwner: row.isPlatformOwner,
      twoFactorEnabled: row.twoFactorEnabled,
      locale: row.locale,
      timezone: row.timezone,
    };
    const [account, membership] = await Promise.all([
      findAccountById(db, name.accountId),
      resolveAccountAccess(db, name.accountId, user.id),
    ]);
    if (!account || !membership || membership.kind === 'inactive' || account.status === 'suspended')
      throw new Error('not_found');
    // plan-lock: a closed account's documents take no live connection.
    if (await accountClosed(db, name.accountId)) throw new Error('account_closed');
    const security = await cachedSecurity(db, name.accountId);
    if (!(await ipAllowedFor(db, user, security, ip))) throw new Error('ip_not_allowed');
    assertTwoFactorGate(security, membership.role, user);
    if (session && !membership.support) assertSsoGate(security, membership.role, { ...user, ...session });
    const ctx: AccountContext = {
      account,
      accountId: name.accountId,
      role: membership.role,
      membershipId: membership.membershipId,
      boardLimit: null,
      support: membership.support,
    };
    const access = await loadDocAccess(db, ctx, user, name.docId); // 404 → refused
    return {
      userId: user.id,
      accountId: name.accountId,
      docId: name.docId,
      name: user.name || user.email,
      // Plans: off the plan's `docs`, docs stay readable — the editor opens read-only.
      readOnly:
        !canDoc(access.perm, 'doc.edit').ok ||
        membership.support?.mode === 'view' ||
        !(await hasFeature(db, name.accountId, 'docs')),
      support: membership.support,
      user,
    };
  };

  /** A new connection under a support grant: the session and the audit row (once a minute per doc). */
  const auditSupportConnect = async (
    c: Omit<CollabContext, 'ip' | 'cookie'> & { user: SessionUser },
    ip: string | null,
  ) => {
    if (!c.support) return;
    const meta = { accountId: c.accountId, user: c.user, support: c.support, via: 'docs' as const, ip };
    await touchSupportSession(deps, meta);
    await auditSupportRequest(db, {
      ...meta,
      kind: c.readOnly ? 'read' : 'write',
      detail: { doc_id: c.docId, read_only: c.readOnly },
      key: `docs ${c.docId}`,
    });
  };
  const connected = async (
    name: { accountId: string; docId: string },
    userId: string,
    ip: string | null,
    session?: { signInMethod: string | null; signInOrg?: string | null },
  ): Promise<Omit<CollabContext, 'ip' | 'cookie'>> => {
    const { user, ...c } = await authorize(name, userId, ip, session);
    await auditSupportConnect({ ...c, user }, ip);
    return c;
  };

  /** Who connects, and how: the session cookie, or a collab token from `POST /docs/:id/collab-token`. */
  const authenticate = async (documentName: string, headers: Headers, token: string): Promise<CollabContext> => {
    const name = parseName(documentName);
    if (!name) throw new Error('not_found');
    const ip = headers.get(RESOLVED_IP_HEADER); // set by onUpgrade from the trusted proxy chain, never by the client
    if (token && token !== 'session') {
      const claims = verifyCollabToken(token, env.BETTER_AUTH_SECRET);
      if (!claims || claims.accountId !== name.accountId || claims.docId !== name.docId)
        throw new Error('unauthenticated');
      return { ...(await connected(name, claims.userId, ip)), ip };
    }
    const session = await sessionOf(headers);
    if (!session) throw new Error('unauthenticated');
    return {
      ...(await connected(name, session.userId, ip, {
        signInMethod: session.signInMethod,
        signInOrg: session.signInOrg,
      })),
      ip,
      cookie: headers.get('cookie') ?? undefined,
    };
  };

  /** Is an open connection still allowed, with the same access (S-24)? */
  const stillAllowed = async (context: CollabContext): Promise<boolean> => {
    try {
      const session = context.cookie ? await sessionOf(new Headers({ cookie: context.cookie })) : null;
      if (context.cookie && session?.userId !== context.userId) return false;
      const fresh = await authorize(
        context,
        context.userId,
        context.ip ?? null,
        session ? { signInMethod: session.signInMethod, signInOrg: session.signInOrg } : undefined,
      );
      return fresh.readOnly === context.readOnly;
    } catch {
      return false;
    }
  };

  /** One save: the state, what is derived from it, and `doc.edited` for whoever changed it (throttled). */
  const store = async (document: Document, lastContext: Partial<CollabContext> | undefined) => {
    const name = parseName(document.name);
    if (!name) return;
    const state = Y.encodeStateAsUpdate(document);
    docBytes.set(document.name, state.byteLength);
    // S-92: a state above the cap is not saved (nor snapshotted) — the last saved state stays.
    if (state.byteLength > maxDocBytes) {
      logger.warn({ doc: name.docId, bytes: state.byteLength }, 'collab: doc state above the size limit — not saved');
      editors.delete(document.name);
      return;
    }
    const derived = deriveDoc(document);
    const users = [...(editors.get(document.name) ?? [])];
    editors.delete(document.name);
    const at = now();
    const actorId = users[users.length - 1] ?? lastContext?.userId ?? null;
    await db.transaction(async (tx) => {
      const before = await loadDocContent(tx, name.accountId, name.docId);
      await storeDocState(
        tx,
        { accountId: name.accountId, id: name.docId },
        { ydoc: state, ...derived, userId: actorId },
      );
      if (users.length) {
        const meta = await findDoc(tx, name.accountId, name.docId);
        const account = meta ? await findAccountById(tx, name.accountId) : undefined;
        if (meta && account) {
          // People newly mentioned (`@`) hear about it once (ד2) — whoever typed it is the actor.
          const had = new Set(docMentionIds(before?.content as RichNode | null));
          const added = docMentionIds(derived.content).filter((id) => !had.has(id));
          if (added.length)
            await notifyDoc(tx, account, { type: 'doc_mention', doc: meta, actorId, excerpt: meta.name }, added);
          // An automatic version at most every 30 minutes of editing (ד3); the rest when the last editor leaves.
          // A restore records its own versions.
          if (!restoring.has(document.name)) {
            dirty.add(document.name);
            const last = (await lastDocVersionAt(tx, name.docId)) ?? meta.createdAt;
            if (at - last.getTime() >= AUTO_VERSION_EVERY_MS) {
              await snapshotDoc(tx, meta, { auto: true, userId: actorId, ydoc: state });
              dirty.delete(document.name);
            }
          }
        }
      }
      for (const userId of users) {
        const key = `${name.docId}:${userId}`;
        if (at - (lastEdited.get(key) ?? -Infinity) < DOC_EDITED_EVERY_MS) continue;
        lastEdited.set(key, at);
        await recordEvent(tx, {
          accountId: name.accountId,
          type: 'doc.edited',
          actorId: userId,
          after: { id: name.docId },
          meta: { doc_id: name.docId },
        });
      }
    });
  };

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'bines-docs',
    quiet: true,
    debounce: opts.debounce ?? 2_000,
    maxDebounce: opts.maxDebounce ?? 10_000,
    async onAuthenticate({ documentName, requestHeaders, token, connectionConfig }) {
      const context = await authenticate(documentName, requestHeaders, token);
      connectionConfig.readOnly = context.readOnly;
      return context;
    },
    async onLoadDocument({ document, documentName }) {
      const name = parseName(documentName)!;
      const row = await loadDocState(db, name.accountId, name.docId);
      if (!row || row.deletedAt) throw new Error('not_found');
      if (row.ydoc?.length) Y.applyUpdate(document, row.ydoc);
      // A doc that has content but no Yjs state yet (an import): its first state is made from the content.
      else if (row.content) Y.applyUpdate(document, encodeState(jsonToYdoc(row.content as RichNode)));
      docBytes.set(documentName, Y.encodeStateAsUpdate(document).byteLength);
    },
    // S-92: a rate per connection, and no content that would take the document past its cap.
    async beforeHandleMessage({ connection, documentName, update }) {
      const at = now();
      const rate = rates.get(connection);
      if (!rate || at - rate.start >= messageRate.windowMs) rates.set(connection, { start: at, count: 1 });
      else if (++rate.count > messageRate.max) {
        logger.warn({ doc: documentName }, 'collab: connection sends too fast — closed');
        closeSocket(connection, COLLAB_CLOSE_TOO_FAST, 'Too many messages');
        throw closeWith(COLLAB_CLOSE_TOO_FAST, 'Too many messages');
      }
      if (connection.readOnly || !carriesContent(update)) return;
      const size = docBytes.get(documentName) ?? 0;
      if (size + update.byteLength > maxDocBytes) {
        logger.warn(
          { doc: documentName, bytes: size, incoming: update.byteLength },
          'collab: doc would pass its size cap',
        );
        closeSocket(connection, COLLAB_CLOSE_TOO_LARGE, 'Document too large');
        throw closeWith(COLLAB_CLOSE_TOO_LARGE, 'Document too large');
      }
    },
    async onChange({ documentName, context, update }) {
      docBytes.set(documentName, (docBytes.get(documentName) ?? 0) + update.byteLength);
      if (!context?.userId) return;
      const set = editors.get(documentName) ?? new Set<string>();
      set.add(context.userId);
      editors.set(documentName, set);
    },
    async onStoreDocument({ document, lastContext }) {
      try {
        await store(document, lastContext);
      } catch (err) {
        logger.error({ err, doc: document.name }, 'collab: storing a doc failed');
        throw err;
      }
    },
    // The last one left (it was saved just before): the edits since the last version become one.
    async afterUnloadDocument({ documentName }) {
      docBytes.delete(documentName);
      if (!dirty.delete(documentName)) return;
      const name = parseName(documentName);
      if (!name) return;
      try {
        const meta = await findDoc(db, name.accountId, name.docId);
        if (meta) await snapshotDoc(db, meta, { auto: true, userId: meta.updatedBy });
      } catch (err) {
        logger.warn({ err, doc: documentName }, 'collab: automatic version failed');
      }
    },
  });

  /** Writes content into a doc through the live server (restore): one change everyone connected receives. */
  const writeLive = async (accountId: string, docId: string, content: RichNode, userId: string) => {
    const documentName = collabName(accountId, docId);
    const conn = await hocuspocus.openDirectConnection(documentName, {
      userId,
      accountId,
      docId,
      name: '',
      readOnly: false,
    });
    restoring.add(documentName);
    try {
      await conn.transact((doc) => replaceFragment(doc, content));
    } finally {
      await conn.disconnect();
      restoring.delete(documentName);
    }
  };
  setLiveDocWriter(writeLive);
  setLiveDocReader((accountId, docId) => {
    const document = hocuspocus.documents.get(collabName(accountId, docId));
    return document ? Y.encodeStateAsUpdate(document) : null;
  });

  const ws = crossws({
    serverOptions: { maxPayload: COLLAB_MAX_MESSAGE_BYTES },
    hooks: {
      open: (peer) => {
        (peer as unknown as { _h?: unknown })._h = hocuspocus.handleConnection(
          peer.websocket as never,
          peer.request as Request,
        );
      },
      message: (peer, message) => {
        (peer as unknown as { _h?: { handleMessage: (d: Uint8Array) => void } })._h?.handleMessage(
          message.uint8Array(),
        );
      },
      close: (peer, event) => {
        (peer as unknown as { _h?: { handleClose: (e: { code?: number; reason?: string }) => void } })._h?.handleClose({
          code: event.code,
          reason: event.reason,
        });
      },
      error: (_peer, err) => logger.warn({ err }, 'collab: websocket error'),
    },
  });

  /** Same-origin only (the cookie authenticates): the app's origin, or the host the request came to. */
  const allowedOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser (a server-side client must then bring a token or a cookie anyway)
    try {
      const o = new URL(origin);
      return o.origin === new URL(env.WEB_ORIGIN).origin || o.host === req.headers.host;
    } catch {
      return false;
    }
  };

  const ipConfig = clientIpConfig(env);
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== COLLAB_PATH || !allowedOrigin(req)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // The client address by the trusted-proxy rules (S-10), for the IP allowlist (S-24) — whatever the client sent
    // in this header is dropped first.
    delete req.headers[RESOLVED_IP_HEADER];
    const ip = resolveClientIp(
      ipConfig,
      {
        get: (n: string) => {
          const v = req.headers[n.toLowerCase()];
          return Array.isArray(v) ? v.join(',') : (v ?? null);
        },
      },
      req.socket.remoteAddress ?? null,
    );
    if (ip) req.headers[RESOLVED_IP_HEADER] = ip;
    ws.handleUpgrade(req, socket, head).catch((err: unknown) => {
      logger.warn({ err }, 'collab: upgrade failed');
      socket.destroy();
    });
  };

  /**
   * Closes the sockets of a doc's connections (the editor opens one socket per doc): the client's provider
   * reconnects by itself and authenticates again — with the access it has now (read-only, or refused).
   * Hocuspocus' own `closeConnections` only ends the doc on a socket that stays open, and the provider does not
   * authenticate again then.
   */
  const resetDoc = (documentName: string) => {
    const document = hocuspocus.documents.get(documentName);
    for (const connection of document?.getConnections() ?? []) {
      const socket = (connection as unknown as { webSocket?: { close?: (code: number, reason: string) => void } })
        .webSocket;
      if (socket?.close) socket.close(4205, 'Reset Connection');
      else connection.close();
    }
  };

  /** Checks the open connections again (of one account, or all) and closes those no longer allowed as they are. */
  let rechecking = false;
  const recheck = async (accountId?: string) => {
    if (rechecking) return;
    rechecking = true;
    try {
      for (const [documentName, document] of hocuspocus.documents) {
        if (accountId && parseName(documentName)?.accountId !== accountId) continue;
        for (const connection of document.getConnections()) {
          const context = connection.context as CollabContext | undefined;
          if (!context?.userId || (await stillAllowed(context))) continue;
          const socket = (connection as unknown as { webSocket?: { close?: (code: number, reason: string) => void } })
            .webSocket;
          if (socket?.close) socket.close(4205, 'Reset Connection');
          else connection.close();
        }
      }
    } catch (err) {
      logger.warn({ err }, 'collab: access recheck failed');
    } finally {
      rechecking = false;
    }
  };
  const recheckTimer = setInterval(() => void recheck(), opts.recheckMs ?? COLLAB_RECHECK_MS);
  recheckTimer.unref?.();

  // Access changed somewhere (any process): reset the doc's connections; clients reconnect and are checked again.
  const unsubscribe = bus.subscribe((e) => {
    if (ACCOUNT_ACCESS_EVENT.test(e.type)) void recheck(e.account_id);
    if (!ACCESS_EVENTS.has(e.type)) return;
    void findEvent(db, e.account_id, e.id)
      .then((ev) => {
        const meta = (ev?.payload as { meta?: { doc_id?: string; access_changed?: boolean } } | undefined)?.meta;
        if (meta?.doc_id && meta.access_changed) resetDoc(collabName(e.account_id, meta.doc_id));
      })
      .catch((err: unknown) => logger.warn({ err }, 'collab: access check failed'));
  });

  return {
    hocuspocus,
    /** Serves `/api/v1/collab` on the API's HTTP server. */
    attach: (server: Server) => {
      server.on('upgrade', onUpgrade);
    },
    /** Saves what is pending and closes every connection (shutdown, tests). */
    close: async () => {
      clearInterval(recheckTimer);
      unsubscribe();
      setLiveDocWriter(null);
      setLiveDocReader(null);
      hocuspocus.flushPendingStores();
      hocuspocus.closeConnections();
      ws.closeAll(1001, 'server shutting down', true);
      // Let the pending stores finish.
      for (let i = 0; i < 50 && hocuspocus.getDocumentsCount() > 0; i++) await new Promise((r) => setTimeout(r, 20));
    },
  };
};

export type Collab = ReturnType<typeof createCollab>;
