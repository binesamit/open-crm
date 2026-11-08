// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canDoc, isRichDocEmpty, newId, renderRichDoc, type RichNode } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertDoc, type DocAccess, loadDocAccess } from './docs.access';
import { notifyDoc } from './docs.notify';
import {
  type CommentRow,
  findComment,
  findThread,
  insertComment,
  insertThread,
  listComments,
  listThreads,
  threadComments,
  type ThreadRow,
  updateComment,
  updateThread,
  userNames,
} from './docs.repo';

/**
 * Comments on a doc (M8 ד3): a thread hangs on one block (its stable id) and quotes the text it was about; replies,
 * edit / delete one's own, resolve / reopen. Whoever may comment on the doc (owner / editor / commenter, a cell
 * doc's readers) writes; readers see them. People mentioned hear "mentioned you"; the others in the thread hear
 * "new comment" — the doc notification rules (`notifyDoc`).
 */
const render = (body: RichNode) => {
  if (isRichDocEmpty(body)) throw new AppError('invalid_value', 'empty_comment');
  return renderRichDoc(body);
};

const commentDto = (c: CommentRow, names: Map<string, string>, userId: string, canManage: boolean) => {
  const r = renderRichDoc(c.body as RichNode);
  return {
    id: c.id,
    thread_id: c.threadId,
    body: c.body as RichNode,
    html: r.html,
    text: r.text,
    author: c.createdBy ? { id: c.createdBy, name: names.get(c.createdBy) ?? '' } : null,
    created_at: c.createdAt.toISOString(),
    edited_at: c.editedAt?.toISOString() ?? null,
    can_edit: c.createdBy === userId || canManage,
  };
};

const threadDto = (
  t: ThreadRow,
  comments: CommentRow[],
  names: Map<string, string>,
  userId: string,
  canManage: boolean,
) => ({
  id: t.id,
  block_id: t.blockId,
  quote: t.quote,
  resolved_at: t.resolvedAt?.toISOString() ?? null,
  resolved_by: t.resolvedBy ? { id: t.resolvedBy, name: names.get(t.resolvedBy) ?? '' } : null,
  created_at: t.createdAt.toISOString(),
  comments: comments.filter((c) => c.threadId === t.id).map((c) => commentDto(c, names, userId, canManage)),
});

/** GET /docs/:id/comments — every live thread with its comments (resolved ones too; the panel filters). */
export const listDocThreads = async (db: Db, a: Actor, docId: string) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  return threadsOf(db, access);
};

const threadsOf = async (db: Db, access: DocAccess) => {
  const [threads, comments] = await Promise.all([listThreads(db, access.doc.id), listComments(db, access.doc.id)]);
  const ids = new Set<string>();
  for (const t of threads) if (t.resolvedBy) ids.add(t.resolvedBy);
  for (const c of comments) if (c.createdBy) ids.add(c.createdBy);
  const names = await userNames(db, [...ids]);
  const canManage = canDoc(access.perm, 'doc.manage').ok;
  return {
    data: threads
      .map((t) => threadDto(t, comments, names, access.userId, canManage))
      // A thread whose every comment was deleted is gone.
      .filter((t) => t.comments.length),
    can_comment: canDoc(access.perm, 'doc.comment').ok,
  };
};

const oneThread = async (db: Db, access: DocAccess, threadId: string) => {
  const all = await threadsOf(db, access);
  const t = all.data.find((x) => x.id === threadId);
  if (!t) throw new AppError('not_found', 'Thread not found');
  return t;
};

/** Notifies the people mentioned in a comment, and the thread's other participants. */
const notifyComment = async (
  tx: Db,
  a: Actor,
  access: DocAccess,
  threadId: string,
  rendered: { text: string; mentions: string[] },
  participants: string[],
) => {
  const draft = { doc: access.doc, actorId: a.user.id, excerpt: rendered.text, threadId };
  const mentioned = await notifyDoc(tx, a.ctx.account, { ...draft, type: 'doc_mention' }, rendered.mentions);
  const told = new Set([...rendered.mentions, ...mentioned]);
  await notifyDoc(
    tx,
    a.ctx.account,
    { ...draft, type: 'doc_comment' },
    participants.filter((id) => !told.has(id)),
  );
};

/** POST /docs/:id/comments — a new thread on a block. */
export const createDocThread = async (
  db: Db,
  a: Actor,
  docId: string,
  input: { block_id: string; quote: string; body: RichNode },
) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.comment');
  const rendered = render(input.body);
  const threadId = newId();
  await db.transaction(async (tx) => {
    await insertThread(tx, {
      id: threadId,
      docId,
      accountId: a.ctx.accountId,
      blockId: input.block_id,
      quote: input.quote.slice(0, 500),
      createdBy: a.user.id,
    });
    await insertComment(tx, {
      id: newId(),
      threadId,
      docId,
      accountId: a.ctx.accountId,
      body: input.body as Record<string, unknown>,
      textValue: rendered.text,
      createdBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.comment_added',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: docId, thread_id: threadId, block_id: input.block_id },
      meta: { doc_id: docId },
    });
    // A new thread: whoever is mentioned; the doc's other people hear of it only when they take part.
    await notifyComment(tx, a, access, threadId, rendered, []);
  });
  return oneThread(db, access, threadId);
};

/** POST /doc-comment-threads/:id/comments — a reply. */
export const replyToThread = async (db: Db, a: Actor, threadId: string, body: RichNode) => {
  const thread = await findThread(db, a.ctx.accountId, threadId);
  if (!thread) throw new AppError('not_found', 'Thread not found');
  const access = await loadDocAccess(db, a.ctx, a.user, thread.docId);
  assertDoc(access, 'doc.comment');
  const rendered = render(body);
  const before = await threadComments(db, threadId);
  await db.transaction(async (tx) => {
    await insertComment(tx, {
      id: newId(),
      threadId,
      docId: thread.docId,
      accountId: a.ctx.accountId,
      body: body as Record<string, unknown>,
      textValue: rendered.text,
      createdBy: a.user.id,
    });
    // A reply reopens a resolved thread (as in Google Docs).
    if (thread.resolvedAt) await updateThread(tx, threadId, { resolvedAt: null, resolvedBy: null });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.comment_added',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: thread.docId, thread_id: threadId },
      meta: { doc_id: thread.docId },
    });
    const participants = [thread.createdBy, ...before.map((c) => c.createdBy)].filter((x): x is string => !!x);
    await notifyComment(tx, a, access, threadId, rendered, participants);
  });
  return oneThread(db, access, threadId);
};

/** PATCH /doc-comments/:id — its author edits it; newly mentioned people are told. */
export const editDocComment = async (db: Db, a: Actor, commentId: string, body: RichNode) => {
  const c = await findComment(db, a.ctx.accountId, commentId);
  if (!c) throw new AppError('not_found', 'Comment not found');
  const access = await loadDocAccess(db, a.ctx, a.user, c.docId);
  assertDoc(access, 'doc.comment');
  if (c.createdBy !== a.user.id) throw new AppError('forbidden', 'not_author');
  const rendered = render(body);
  const had = new Set(renderRichDoc(c.body as RichNode).mentions);
  await db.transaction(async (tx) => {
    await updateComment(tx, c.id, {
      body: body as Record<string, unknown>,
      textValue: rendered.text,
      editedAt: new Date(),
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.comment_edited',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: c.docId, comment_id: c.id },
      meta: { doc_id: c.docId },
    });
    await notifyDoc(
      tx,
      a.ctx.account,
      { type: 'doc_mention', doc: access.doc, actorId: a.user.id, excerpt: rendered.text, threadId: c.threadId },
      rendered.mentions.filter((id) => !had.has(id)),
    );
  });
  return oneThread(db, access, c.threadId);
};

/** DELETE /doc-comments/:id — its author, or whoever manages the doc. */
export const deleteDocComment = async (db: Db, a: Actor, commentId: string) => {
  const c = await findComment(db, a.ctx.accountId, commentId);
  if (!c) throw new AppError('not_found', 'Comment not found');
  const access = await loadDocAccess(db, a.ctx, a.user, c.docId);
  if (c.createdBy !== a.user.id) assertDoc(access, 'doc.manage');
  await db.transaction(async (tx) => {
    await updateComment(tx, c.id, { deletedAt: new Date() });
    if (!(await threadComments(tx, c.threadId)).length) await updateThread(tx, c.threadId, { deletedAt: new Date() });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.comment_deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id: c.docId, comment_id: c.id, thread_id: c.threadId },
      meta: { doc_id: c.docId },
    });
  });
  return threadsOf(db, access);
};

/** POST /doc-comment-threads/:id/resolve — `{resolved}`: resolve or reopen (whoever may comment). */
export const resolveDocThread = async (db: Db, a: Actor, threadId: string, resolved: boolean) => {
  const thread = await findThread(db, a.ctx.accountId, threadId);
  if (!thread) throw new AppError('not_found', 'Thread not found');
  const access = await loadDocAccess(db, a.ctx, a.user, thread.docId);
  assertDoc(access, 'doc.comment');
  await db.transaction(async (tx) => {
    await updateThread(
      tx,
      threadId,
      resolved ? { resolvedAt: new Date(), resolvedBy: a.user.id } : { resolvedAt: null, resolvedBy: null },
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: resolved ? 'doc.thread_resolved' : 'doc.thread_reopened',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: thread.docId, thread_id: threadId },
      meta: { doc_id: thread.docId },
    });
  });
  return oneThread(db, access, threadId);
};
