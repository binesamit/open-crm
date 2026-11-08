// SPDX-License-Identifier: AGPL-3.0-only
import * as Y from 'yjs';
import { AppError, DOC_FRAGMENT, newId, type RichNode } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertDoc, loadDocAccess } from './docs.access';
import { findDocVersion, insertDocVersion, listDocVersions, loadDocState, storeDocState, userNames } from './docs.repo';
import { decodeState, deriveDoc, encodeState, jsonToYdoc } from './ydoc';

/**
 * Doc versions (M8 ד3, plan §3.3): automatic snapshots — after editing, at most every 30 minutes of it, and when
 * the last editor leaves — plus named versions anyone who edits may save. A version can be previewed and restored;
 * restoring writes its content into the live doc as a new change (everyone connected sees it at once) and records
 * a new version, so history is never rewritten.
 */
export const AUTO_VERSION_EVERY_MS = 30 * 60_000;

/** The live collab server, when this process runs one (restore writes through it, so open editors get it). */
type LiveWriter = (accountId: string, docId: string, content: RichNode, userId: string) => Promise<void>;
let liveWriter: LiveWriter | null = null;
export const setLiveDocWriter = (w: LiveWriter | null) => {
  liveWriter = w;
};
/** The doc as it is in the live server's memory now (saves are debounced) — null when it is not open here. */
type LiveReader = (accountId: string, docId: string) => Uint8Array | null;
let liveReader: LiveReader | null = null;
export const setLiveDocReader = (r: LiveReader | null) => {
  liveReader = r;
};
export const liveDocState = (accountId: string, docId: string) => liveReader?.(accountId, docId) ?? null;

/** Saves a version of the doc as it is stored now. Returns its id (null when the doc has no content yet). */
export const snapshotDoc = async (
  tx: Db,
  doc: { accountId: string; id: string },
  opts: { label?: string | null; auto: boolean; userId: string | null; ydoc?: Uint8Array },
) => {
  const state = opts.ydoc ? { ydoc: opts.ydoc, content: null } : await loadDocState(tx, doc.accountId, doc.id);
  if (!state) return null;
  const ydoc = state.ydoc?.length
    ? state.ydoc
    : state.content
      ? encodeState(jsonToYdoc(state.content as RichNode))
      : encodeState(new Y.Doc());
  const derived = deriveDoc(decodeState(ydoc));
  const id = newId();
  await insertDocVersion(tx, {
    id,
    docId: doc.id,
    accountId: doc.accountId,
    ydoc,
    content: derived.content as Record<string, unknown>,
    textValue: derived.text,
    label: opts.label ?? null,
    auto: opts.auto,
    createdBy: opts.userId,
  });
  return id;
};

const versionDto = (
  v: { id: string; label: string | null; auto: boolean; createdAt: Date; createdBy: string | null },
  names: Map<string, string>,
) => ({
  id: v.id,
  label: v.label,
  auto: v.auto,
  created_at: v.createdAt.toISOString(),
  created_by: v.createdBy ? { id: v.createdBy, name: names.get(v.createdBy) ?? '' } : null,
});

/** GET /docs/:id/versions — newest first. */
export const listVersions = async (db: Db, a: Actor, docId: string) => {
  await loadDocAccess(db, a.ctx, a.user, docId);
  const rows = await listDocVersions(db, docId);
  const names = await userNames(db, [...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))]);
  return { data: rows.map((r) => versionDto(r, names)) };
};

/** GET /docs/:id/versions/:v — a version's content (preview). */
export const getVersion = async (db: Db, a: Actor, docId: string, versionId: string) => {
  await loadDocAccess(db, a.ctx, a.user, docId);
  const v = await findDocVersion(db, docId, versionId);
  if (!v) throw new AppError('not_found', 'Version not found');
  const names = await userNames(db, v.createdBy ? [v.createdBy] : []);
  return { ...versionDto(v, names), content: (v.content as RichNode | null) ?? null, text: v.textValue };
};

/** POST /docs/:id/versions — "save a version" with a name (whoever edits). */
export const createVersion = async (db: Db, a: Actor, docId: string, label: string) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.edit');
  const live = liveDocState(a.ctx.accountId, docId);
  const id = await db.transaction(async (tx) => {
    const vid = await snapshotDoc(tx, access.doc, {
      label,
      auto: false,
      userId: a.user.id,
      ...(live ? { ydoc: live } : {}),
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.version_saved',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: docId, version_id: vid, label },
      meta: { doc_id: docId },
    });
    return vid;
  });
  return getVersion(db, a, docId, id!);
};

/**
 * POST /docs/:id/versions/:v/restore — the version's content becomes the doc's (a new change for everyone
 * connected), then a version "restored" is recorded. What was there before stays in the history: a version of
 * it is saved first.
 */
export const restoreVersion = async (db: Db, a: Actor, docId: string, versionId: string) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.edit');
  const v = await findDocVersion(db, docId, versionId);
  if (!v) throw new AppError('not_found', 'Version not found');
  const content = (v.content as RichNode | null) ?? deriveDoc(decodeState(v.ydoc)).content;
  // What is there now (live, when open), kept before it is replaced.
  const now = liveDocState(a.ctx.accountId, docId);
  await snapshotDoc(db, access.doc, { label: null, auto: true, userId: a.user.id, ...(now ? { ydoc: now } : {}) });
  if (liveWriter) await liveWriter(a.ctx.accountId, docId, content, a.user.id);
  else {
    // No collab server here (worker, tests): the stored state is the truth — replace it.
    const ydoc = jsonToYdoc(content);
    await db.transaction(async (tx) =>
      storeDocState(tx, access.doc, { ydoc: encodeState(ydoc), ...deriveDoc(ydoc), userId: a.user.id }),
    );
  }
  const restoredId = await db.transaction(async (tx) => {
    const label = `↺ ${v.label ?? v.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`.slice(0, 120);
    const id = await snapshotDoc(tx, access.doc, {
      label,
      auto: false,
      userId: a.user.id,
      ydoc: encodeState(jsonToYdoc(content)),
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.version_restored',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: docId, version_id: versionId, new_version_id: id },
      meta: { doc_id: docId },
    });
    return id;
  });
  return getVersion(db, a, docId, restoredId!);
};

/** Replaces the content of a live Y.Doc's fragment with `content` (one transaction — one change for everyone). */
export const replaceFragment = (doc: Y.Doc, content: RichNode) => {
  const fragment = doc.getXmlFragment(DOC_FRAGMENT);
  fragment.delete(0, fragment.length);
  Y.applyUpdate(doc, encodeState(jsonToYdoc(content)));
};
