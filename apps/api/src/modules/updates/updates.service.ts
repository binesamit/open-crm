// SPDX-License-Identifier: AGPL-3.0-only
import {
  ACTIVITY_SYSTEM_ACTOR,
  AppError,
  type BoardActivityQuery,
  displayUpdateHtml,
  isRichDocEmpty,
  markdownToRichDoc,
  mentionedUserIds,
  MAX_REPLY_DEPTH,
  MAX_RICH_TEXT,
  MAX_UPDATE_FILES,
  newId,
  REACTIONS,
  renderRichDoc,
  updateImageOptions,
  renderUpdateBody,
  type RichNode,
  setTaskChecked,
  type UpdateDto,
  type UpdateDocumentMeta,
  type UpdateEmailMeta,
  type UpdateEmailReplyMeta,
  updateDocumentMetaOf,
  updateEmailMetaOf,
  updateEmailReplyMetaOf,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { FileStorage } from '../../lib/storage';
import type { AppDeps, Actor } from '../../types';
import { loadSettings } from '../accounts/accounts.service';
import { recordEvent } from '../activity/activity.repo';
import { type BoardAccess, columnAllowed, isOwnerOrAdmin, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard } from '../boards/boards.repo';
import { isUndoable, mayUndo } from '../activity/undo.service';
import { fileDto, ownUploadedAssets, releaseAssets } from '../files/files.service';
import { deleteUpdateFile, insertUpdateFiles, updateFileAssets } from '../files/files.repo';
import { findItem, isAccountMember, itemsByIds } from '../items/items.repo';
import { boardVisibility, visibilitySql, visibleAcrossBoards } from '../items/visibility';
import { loadItem } from '../items/items.service';
import { notifyUpdate } from '../notifications/notifications.service';
import { trashObject } from '../trash/trash.service';
import { putUpdateBody } from '../secrets/secrets.repo';
import {
  assertMayChangeSecretUpdate,
  assertMayWriteSecret,
  sealSecretBody,
  secretUpdateSettingsFor,
  type SecretWriter,
} from '../secrets/secret-updates.service';
import { auditOf } from '../secrets/secrets.service';
import {
  editUpdate,
  findUpdate,
  insertUpdate,
  likesOf,
  type ActivityLogRow,
  listBoardActivity,
  viewRestrictedColumns,
  updateCountsOf,
  listItemActivity,
  listItemUpdates,
  mentionsOf,
  replaceMentions,
  react,
  setUpdateBody,
  softDeleteUpdate,
  unreact,
  type UpdateRow,
} from './updates.repo';
import { seenOf } from './views.service';

/**
 * update.create (05 §5.4): everyone who can read the item may comment, except account viewers unless
 * `perm.viewer_can_comment` is on.
 */
export const assertCanComment = async (db: Db, a: Actor) => {
  if (a.ctx.role !== 'viewer') return;
  const settings = await loadSettings(db, a.ctx.accountId);
  if (!settings.permissions.viewer_can_comment) throw new AppError('forbidden', 'viewer_read_only');
};

/** What a client sends: rich `doc` (rendered through the allowlist) or plain `body`. */
/**
 * `body`: plain text (line breaks kept, links and `[@Name](user:<id>)` mentions recognised); `doc`: the editor's
 * rich JSON; `markdown` (sync-ai — what AI writers send): read as Markdown and stored as a rich doc, so headings,
 * lists, tables and links show formatted.
 */
export type UpdateInput = { body?: string; doc?: RichNode; markdown?: string; secret?: boolean };

/**
 * What a secret update reads as wherever its text would show — notifications, the inbox, the trash
 * only that there is one. The text itself is in `secret_update_bodies`, encrypted.
 */
export const SECRET_UPDATE_EXCERPT = '🔒';

/**
 * Renders the input to stored HTML/text and checks that every mention is a member of the account.
 * `withFiles`: the update carries attached files, so no text is fine (Fix: ) — it is stored as empty
 * html/text (the UI then shows only the files); without files an empty update is refused.
 */
const renderInput = async (db: Db, a: Actor, raw: UpdateInput, withFiles = false) => {
  const input: UpdateInput =
    raw.markdown !== undefined && !raw.doc && raw.markdown.trim()
      ? { doc: markdownToRichDoc(raw.markdown) }
      : raw.markdown !== undefined && !raw.doc && !raw.body
        ? { body: raw.markdown }
        : raw;
  let out: { html: string; text: string; mentions: string[]; json: Record<string, unknown> | null };
  // an image put into the text counts as content (an update of one pasted image keeps its place).
  const docEmpty =
    !input.doc || (isRichDocEmpty(input.doc) && !renderRichDoc(input.doc, updateImageOptions).html.includes('<figure'));
  const bodyEmpty = !input.body?.trim();
  if (docEmpty && bodyEmpty) {
    if (!withFiles) throw new AppError('validation_failed', 'empty_update');
    out = { html: '', text: '', mentions: [], json: null };
  } else if (input.doc && !docEmpty) {
    // Images: files of the update only — an incoming email's or pasted into the text
    // filled in by the app — see updateImageOptions.
    out = { ...renderRichDoc(input.doc, updateImageOptions), json: input.doc as Record<string, unknown> };
  } else {
    const body = input.body ?? '';
    out = { ...renderUpdateBody(body), mentions: mentionedUserIds(body), json: null };
  }
  // r17reply: too long is said so, with the limit (the app shows it), instead of a bare validation failure.
  if (out.text.length > MAX_RICH_TEXT) {
    throw new AppError('payload_too_large', 'update_too_long', { limit: MAX_RICH_TEXT, length: out.text.length });
  }
  if (!(await isAccountMember(db, a.ctx.accountId, out.mentions))) {
    throw new AppError('invalid_value', 'Unknown mentioned user');
  }
  return out;
};

/** The SMS details of an update sent as an SMS (`updates.meta.sms`), else null. */
const smsMetaOf = (meta: unknown) => {
  const sms = (meta as { sms?: { to?: unknown; column_id?: unknown } } | null)?.sms;
  return sms && typeof sms.to === 'string'
    ? { to: sms.to, column_id: typeof sms.column_id === 'string' ? sms.column_id : null }
    : null;
};

/** `storage`: signs the viewers' photos in `seen` (without it, only an external photo link is given). */
export const listUpdates = async (db: Db, a: Actor, itemId: string, storage?: FileStorage): Promise<UpdateDto[]> => {
  await loadItem(db, a, itemId);
  const rows = await listItemUpdates(db, itemId);
  const ids = rows.map((r) => r.update.id);
  const [mentions, likes, files, seen] = await Promise.all([
    mentionsOf(db, ids),
    likesOf(db, ids),
    updateFileAssets(db, ids),
    seenOf(db, a, ids, storage),
  ]);
  const dto = (r: (typeof rows)[number]) => {
    const own = likes.filter((l) => l.updateId === r.update.id);
    const likeRows = own.filter((l) => l.reaction === 'like');
    // Fixed order (REACTIONS), so chips never jump around when someone removes theirs.
    const reactions = REACTIONS.filter((x) => own.some((l) => l.reaction === x)).map((reaction) => {
      const rows = own.filter((l) => l.reaction === reaction);
      return { reaction, count: rows.length, me: rows.some((l) => l.userId === a.user.id) };
    });
    return {
      id: r.update.id,
      item_id: r.update.itemId,
      body_html: displayUpdateHtml(r.update.bodyHtml, r.update.bodyText),
      body_text: r.update.bodyText,
      author: r.update.createdBy ? { id: r.update.createdBy, name: r.authorName || r.authorEmail || '' } : null,
      created_at: r.update.createdAt.toISOString(),
      edited_at: r.update.editedAt?.toISOString() ?? null,
      mentions: mentions.filter((m) => m.updateId === r.update.id && m.userId).map((m) => m.userId!),
      likes: { count: likeRows.length, me: likeRows.some((l) => l.userId === a.user.id) },
      reactions,
      body_json: (r.update.bodyJson as Record<string, unknown> | null) ?? null,
      files: files.filter((f) => f.updateId === r.update.id).map((f) => fileDto(f.asset)),
      seen: seen(r.update.id),
      source: r.update.source,
      sms: smsMetaOf(r.update.meta),
      email: updateEmailMetaOf(r.update.meta),
      email_reply: updateEmailReplyMetaOf(r.update.meta),
      document: updateDocumentMetaOf(r.update.meta),
      secret: r.update.isSecret,
    };
  };
  const top = rows.filter((r) => !r.update.parentUpdateId);
  // Replies to replies (MAX_REPLY_DEPTH): the whole thread, depth first, oldest first at every level.
  const thread = (parentId: string): UpdateDto['replies'] =>
    rows
      .filter((x) => x.update.parentUpdateId === parentId)
      .reverse()
      .flatMap((x) => [{ ...dto(x), parent_update_id: parentId }, ...thread(x.update.id)]);
  return top.map((r) => ({ ...dto(r), pinned: r.update.isPinned, replies: thread(r.update.id) }));
};

/** One update or reply out of the item's threads (a top update has no parent). */
const entryOf = (threads: UpdateDto[], id: string) =>
  threads.flatMap((u) => [{ ...u, parent_update_id: null as string | null }, ...u.replies]).find((u) => u.id === id)!;

/** What a files-only update reads as in notifications, the inbox and the trash: "📎 a.pdf, b.png". */
const filesExcerpt = (files: { fileName: string }[]) =>
  files.length ? `📎 ${files.map((f) => f.fileName).join(', ')}` : '';

/**
 * Where an update came from when not typed in the app: an email — the sender is kept in `meta.email`
 * `email.external` = not a verified member, so the update has no author (it shows the sender) and the actor (the
 * address's creator) is told about it like any follower.
 */
/** An update that came in by email (with its images from the web for the proxy), or from a client on an
 * interactive document's page. */
type UpdateOrigin =
  | { email: UpdateEmailMeta; email_images?: string[] }
  | { document: UpdateDocumentMeta }
  | { email_reply: UpdateEmailReplyMeta };
type OriginActor = Actor & { inbound?: { external: boolean } };

/**
 * `sw`: the request's secret context (REST only) — without it a secret update cannot be written, so AI, agents, MCP
 * and automations never write into a secret thread. `inSecretThread`: the update answers a secret one.
 */
const create = async (
  db: Db,
  a: OriginActor,
  itemId: string,
  input: UpdateInput,
  parent: UpdateRow | null,
  fileIds: string[] = [],
  sw?: SecretWriter,
  inSecretThread = false,
  origin?: UpdateOrigin,
) => {
  const { item } = await loadItem(db, a, itemId);
  await assertCanComment(db, a);
  const secret = !!input.secret || inSecretThread;
  if (secret) {
    if (!sw) throw new AppError('forbidden', 'secret_update_needs_session');
    // Files live outside the encrypted text (storage, previews, search by name): not on a secret update.
    if (fileIds.length) throw new AppError('invalid_value', 'secret_update_no_files');
    await assertMayWriteSecret(db, a, (await secretUpdateSettingsFor(db, a.ctx.accountId, item.boardId)).effective);
  }
  const files = fileIds.length ? await ownUploadedAssets(db, a, fileIds) : [];
  const { html, text, mentions, json } = await renderInput(db, a, input, files.length > 0);
  const id = newId();
  // Encrypted before the transaction (a missing master key fails here, nothing written).
  const sealed = secret && sw ? await sealSecretBody(sw.env, db, a.ctx.accountId, id, { html, text, json }) : null;
  await db.transaction(async (tx) => {
    await insertUpdate(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId: item.boardId,
      itemId: item.id,
      parentUpdateId: parent?.id ?? null,
      bodyHtml: sealed ? '' : html,
      bodyText: sealed ? '' : text,
      bodyJson: sealed ? null : json,
      isSecret: !!sealed,
      source: origin ? ('document' in origin ? 'document' : 'email') : 'user',
      ...(origin
        ? {
            meta:
              'email' in origin
                ? { email: origin.email, ...(origin.email_images ? { email_images: origin.email_images } : {}) }
                : 'email_reply' in origin
                  ? { email_reply: origin.email_reply }
                  : { document: origin.document },
          }
        : {}),
      // An outside sender (an email from a non-member, a client on a document's page) is not an author.
      createdBy: origin && ('document' in origin || ('email' in origin && origin.email.external)) ? null : a.user.id,
    });
    if (sealed) {
      await putUpdateBody(tx, { updateId: id, accountId: a.ctx.accountId, ciphertext: sealed, updatedBy: a.user.id });
      await auditOf(
        tx,
        { ...a, ...sw! },
        'secret.set',
        { itemId: item.id, boardId: item.boardId, itemName: item.name },
        { update_id: id, kind: 'update', replaced: false },
      );
    }
    await replaceMentions(tx, a.ctx.accountId, id, mentions, newId);
    await insertUpdateFiles(
      tx,
      files.map((f, i) => ({
        updateId: id,
        assetId: f.id,
        accountId: a.ctx.accountId,
        position: String(i).padStart(4, '0'),
      })),
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: parent ? 'update.replied' : 'update.created',
      actorId: a.user.id,
      ...(origin && !('email_reply' in origin)
        ? { actorType: 'email' in origin ? ('email' as const) : ('document' as const) }
        : {}),
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      after: { update_id: id, parent_update_id: parent?.id ?? null, mentions, ...(sealed ? { secret: true } : {}) },
    });
    await notifyUpdate(tx, a, item, {
      id,
      text: sealed ? SECRET_UPDATE_EXCERPT : text || filesExcerpt(files),
      mentions,
      parentAuthorId: parent?.createdBy,
    });
  });
  return entryOf(await listUpdates(db, a, itemId), id);
};

export const createUpdate = (
  db: Db,
  a: Actor,
  itemId: string,
  input: UpdateInput,
  fileIds?: string[],
  sw?: SecretWriter,
) => create(db, a, itemId, input, null, fileIds, sw);

/**
 * An update that came in by email: `a` is the sender when they are a verified member who may comment
 * else the address's creator with `inbound.external` (the update then has no author). Never secret.
 */
export const createEmailUpdate = (
  db: Db,
  a: OriginActor,
  itemId: string,
  input: { doc: RichNode },
  fileIds: string[],
  email: UpdateEmailMeta,
  /** the message's images from the web (`remote:<n>` in the document), shown through the app's proxy. */
  remoteImages: string[] = [],
) =>
  create(db, { ...a, inbound: { external: email.external } }, itemId, input, null, fileIds, undefined, false, {
    email,
    ...(remoteImages.length ? { email_images: remoteImages } : {}),
  });

/**
 * A reply sent by email to whoever emailed the item, kept as its update: the author is who sent it
 * (a person or an agent), `meta.email_reply` says to whom.
 */
export const createEmailReplyUpdate = (db: Db, a: Actor, itemId: string, text: string, reply: UpdateEmailReplyMeta) =>
  create(db, a, itemId, { body: text }, null, [], undefined, false, { email_reply: reply });

/**
 * A client's question or reply on an interactive document's page: `a` is the document's sender
 * (their rights); the update has no author and shows the client's name; the sender hears of it like a follower.
 * `parent`: the question it answers (already checked to belong to the document). Never secret, no files.
 */
export const createDocumentUpdate = (
  db: Db,
  a: Actor,
  itemId: string,
  input: { doc: RichNode },
  document: UpdateDocumentMeta,
  parent: UpdateRow | null,
) => create(db, { ...a, inbound: { external: true } }, itemId, input, parent, [], undefined, false, { document });

export const replyToUpdate = async (
  db: Db,
  a: Actor,
  updateId: string,
  input: UpdateInput,
  fileIds?: string[],
  sw?: SecretWriter,
) => {
  const parent = await findUpdate(db, a.ctx.accountId, updateId);
  if (!parent) throw new AppError('not_found', 'Update not found');
  // A reply answers that update or reply; past MAX_REPLY_DEPTH it joins its parent's level.
  const chain = [parent];
  while (chain[0]!.parentUpdateId) {
    const up = await findUpdate(db, a.ctx.accountId, chain[0]!.parentUpdateId);
    if (!up) break;
    chain.unshift(up);
  }
  const target = chain.length > MAX_REPLY_DEPTH ? chain[MAX_REPLY_DEPTH - 1]! : parent;
  // A reply anywhere in a secret thread is secret too: the whole thread stays locked.
  return create(
    db,
    a,
    parent.itemId,
    input,
    target,
    fileIds,
    sw,
    chain.some((u) => u.isSecret),
  );
};

const loadOwnUpdate = async (db: Db, a: Actor, updateId: string) => {
  const update = await findUpdate(db, a.ctx.accountId, updateId);
  if (!update) throw new AppError('not_found', 'Update not found');
  const { access } = await loadItem(db, a, update.itemId);
  return { update, access };
};

/** What an edit may change besides the text (f9-updedit): files to attach and attached files to take off. */
export type UpdateFileChanges = { add?: string[]; remove?: string[] };

/**
 * PATCH /updates/{id}: only its author edits an update or reply — its text (left out = unchanged) and, under the
 * same conditions as posting (f9-updedit), its files: added files must be the editor's own finished
 * uploads in this account (and the editor may comment), removed ones must be on this update; at most
 * MAX_UPDATE_FILES stay attached and text and files may not both end up empty. Removed files are detached
 * (event `file.removed`, like the viewer's remove) and leave storage unless something else still holds them.
 * The update is marked edited.
 */
export const editOwnUpdate = async (
  deps: Pick<AppDeps, 'db' | 'storage' | 'logger'>,
  a: Actor,
  updateId: string,
  input: UpdateInput,
  changes: UpdateFileChanges = {},
  sw?: SecretWriter,
) => {
  const { db } = deps;
  const { update } = await loadOwnUpdate(db, a, updateId);
  if (update.createdBy !== a.user.id) throw new AppError('forbidden', 'author_only');
  if (update.isSecret) return editSecretUpdate(db, a, update, input, changes, sw);
  const attached = await updateFileAssets(db, [update.id]);
  const removeIds = [...new Set(changes.remove ?? [])];
  const removed = removeIds.map((id) => {
    const f = attached.find((x) => x.asset.id === id);
    if (!f) throw new AppError('not_found', 'File not found');
    return f.asset;
  });
  const addIds = [...new Set(changes.add ?? [])].filter((id) => !attached.some((x) => x.asset.id === id));
  if (addIds.length) await assertCanComment(db, a);
  const added = addIds.length ? await ownUploadedAssets(db, a, addIds) : [];
  const kept = attached.filter((x) => !removeIds.includes(x.asset.id));
  if (kept.length + added.length > MAX_UPDATE_FILES) {
    throw new AppError('invalid_value', 'too_many_files', { limit: MAX_UPDATE_FILES });
  }
  const withFiles = kept.length + added.length > 0;
  const textGiven = input.body !== undefined || input.doc !== undefined || input.markdown !== undefined;
  const previousMentions = (await mentionsOf(db, [update.id])).flatMap((m) => (m.userId ? [m.userId] : []));
  const rendered = textGiven
    ? await renderInput(db, a, input, withFiles)
    : {
        html: update.bodyHtml,
        text: update.bodyText,
        mentions: previousMentions,
        json: (update.bodyJson as Record<string, unknown> | null) ?? null,
      };
  if (!textGiven && !withFiles && !update.bodyText.trim()) throw new AppError('validation_failed', 'empty_update');
  const { html, text, mentions, json } = rendered;
  const item = await findItem(db, a.ctx.accountId, update.itemId);
  // Positions continue after the last kept file, so the new ones show after the old.
  const lastPosition = attached.length ? Number(attached.at(-1)!.position) || attached.length : -1;
  await db.transaction(async (tx) => {
    await editUpdate(tx, update.id, html, text, json);
    await replaceMentions(tx, a.ctx.accountId, update.id, mentions, newId);
    for (const f of removed) {
      await deleteUpdateFile(tx, update.id, f.id);
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'file.removed',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: update.boardId,
        itemId: update.itemId,
        before: { file_id: f.id, name: f.fileName, update_id: update.id },
      });
    }
    await insertUpdateFiles(
      tx,
      added.map((f, i) => ({
        updateId: update.id,
        assetId: f.id,
        accountId: a.ctx.accountId,
        position: String(lastPosition + 1 + i).padStart(4, '0'),
      })),
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'update.edited',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: update.boardId,
      itemId: update.itemId,
      before: { body_text: update.bodyText },
      after: {
        body_text: text,
        ...(added.length ? { added_file_ids: added.map((f) => f.id) } : {}),
        ...(removed.length ? { removed_file_ids: removed.map((f) => f.id) } : {}),
      },
    });
    const excerpt = text || filesExcerpt([...kept.map((x) => x.asset), ...added]);
    if (item)
      await notifyUpdate(tx, a, item, { id: update.id, text: excerpt, mentions, previousMentions, edited: true });
  });
  if (removed.length)
    await releaseAssets(
      deps,
      a.ctx.accountId,
      removed.map((f) => f.id),
    );
  return entryOf(await listUpdates(db, a, update.itemId), update.id);
};

/**
 * PUT /updates/{id}/tasks/{index}: ticks or clears one check box of an update or reply — not only
 * its author: whoever may comment on the item (account viewers only with `perm.viewer_can_comment`). Only that box
 * changes (the text is the stored one, so nobody else's words can be rewritten); the update is not marked edited.
 * A secret update is never ticked this way (its text is sealed). Event `update.edited` with the box.
 */
export const setUpdateTask = async (db: Db, a: Actor, updateId: string, index: number, checked: boolean) => {
  const { update } = await loadOwnUpdate(db, a, updateId);
  if (update.isSecret) throw new AppError('forbidden', 'secret_update');
  if (update.createdBy !== a.user.id) await assertCanComment(db, a);
  const doc = update.bodyJson as RichNode | null;
  const next = doc ? setTaskChecked(doc, index, checked) : null;
  if (!next) throw new AppError('not_found', 'Check box not found');
  const { html } = renderRichDoc(next, updateImageOptions);
  await db.transaction(async (tx) => {
    await setUpdateBody(tx, update.id, html, next as Record<string, unknown>);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'update.edited',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: update.boardId,
      itemId: update.itemId,
      before: { body_text: update.bodyText },
      after: { body_text: update.bodyText, task: { index, checked } },
    });
  });
  return entryOf(await listUpdates(db, a, update.itemId), update.id);
};

/**
 * A secret update's edit: the author, new text only (no files), with a fresh code when the board's
 * settings ask for one; the text is encrypted again, nothing of it reaches the event, the notification or the audit.
 */
const editSecretUpdate = async (
  db: Db,
  a: Actor,
  update: UpdateRow,
  input: UpdateInput,
  changes: UpdateFileChanges,
  sw?: SecretWriter,
) => {
  if (!sw) throw new AppError('forbidden', 'secret_update_needs_session');
  if (changes.add?.length || changes.remove?.length) throw new AppError('invalid_value', 'secret_update_no_files');
  const textGiven = input.body !== undefined || input.doc !== undefined || input.markdown !== undefined;
  if (!textGiven) throw new AppError('validation_failed', 'empty_update');
  const sa = { ...a, ...sw };
  await assertMayChangeSecretUpdate(db, sa, update.boardId);
  const previousMentions = (await mentionsOf(db, [update.id])).flatMap((m) => (m.userId ? [m.userId] : []));
  const { html, text, mentions, json } = await renderInput(db, a, input, false);
  const sealed = await sealSecretBody(sw.env, db, a.ctx.accountId, update.id, { html, text, json });
  const item = await findItem(db, a.ctx.accountId, update.itemId);
  await db.transaction(async (tx) => {
    await editUpdate(tx, update.id, '', '', null);
    await putUpdateBody(tx, {
      updateId: update.id,
      accountId: a.ctx.accountId,
      ciphertext: sealed,
      updatedBy: a.user.id,
    });
    await replaceMentions(tx, a.ctx.accountId, update.id, mentions, newId);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'update.edited',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: update.boardId,
      itemId: update.itemId,
      before: { update_id: update.id, secret: true },
      after: { update_id: update.id, secret: true },
    });
    await auditOf(
      tx,
      sa,
      'secret.set',
      { itemId: update.itemId, boardId: update.boardId, itemName: item?.name },
      { update_id: update.id, kind: 'update', replaced: true },
    );
    if (item)
      await notifyUpdate(tx, a, item, {
        id: update.id,
        text: SECRET_UPDATE_EXCERPT,
        mentions,
        previousMentions,
        edited: true,
      });
  });
  return entryOf(await listUpdates(db, a, update.itemId), update.id);
};

/**
 * Authors delete their own; board owners and admins delete anyone's (05 §5.4 update.delete_others). A secret update
 * also takes a fresh code when the board's settings ask for one; it goes to the trash still sealed.
 */
export const deleteUpdate = async (db: Db, a: Actor, updateId: string, sw?: SecretWriter) => {
  const { update, access } = await loadOwnUpdate(db, a, updateId);
  if (update.createdBy !== a.user.id && !isOwnerOrAdmin(access)) throw new AppError('forbidden', 'author_only');
  if (update.isSecret) {
    if (!sw) throw new AppError('forbidden', 'secret_update_needs_session');
    await assertMayChangeSecretUpdate(db, { ...a, ...sw }, update.boardId);
  }
  return db.transaction(async (tx) => {
    await softDeleteUpdate(tx, update.id);
    if (update.isSecret) {
      const item = await findItem(tx, a.ctx.accountId, update.itemId);
      await auditOf(
        tx,
        { ...a, ...sw! },
        'secret.cleared',
        { itemId: update.itemId, boardId: update.boardId, itemName: item?.name },
        { update_id: update.id, kind: 'update' },
      );
    }
    const name = update.isSecret
      ? SECRET_UPDATE_EXCERPT
      : update.bodyText || filesExcerpt((await updateFileAssets(tx, [update.id])).map((f) => f.asset));
    const entryId = await trashObject(tx, a, {
      type: 'update',
      id: update.id,
      name: name.slice(0, 120),
      boardId: update.boardId,
    });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'update.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: update.boardId,
      itemId: update.itemId,
      before: { update_id: update.id, body_text: update.bodyText, ...(update.isSecret ? { secret: true } : {}) },
      meta: { trash_entry_id: entryId },
    });
  });
};

/**
 * Removes one attached file from an update or reply (the file viewer's "remove"): the same people who may delete
 * the update — its author, board owners and admins. The file then leaves storage (R2) unless another place
 * still holds it (owner fix6-server 2a).
 */
export const removeUpdateFile = async (
  deps: Pick<AppDeps, 'db' | 'storage' | 'logger'>,
  a: Actor,
  updateId: string,
  fileId: string,
) => {
  const { db } = deps;
  const { update, access } = await loadOwnUpdate(db, a, updateId);
  if (update.createdBy !== a.user.id && !isOwnerOrAdmin(access)) throw new AppError('forbidden', 'author_only');
  const attached = await updateFileAssets(db, [update.id]);
  const file = attached.find((f) => f.asset.id === fileId);
  if (!file) throw new AppError('not_found', 'File not found');
  await db.transaction(async (tx) => {
    await deleteUpdateFile(tx, update.id, fileId);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.removed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: update.boardId,
      itemId: update.itemId,
      before: { file_id: fileId, name: file.asset.fileName, update_id: update.id },
    });
  });
  await releaseAssets(deps, a.ctx.accountId, [fileId]);
};

/** Anyone who can read the item may react; one row per user per reaction (👍 = `like`). */
export const setReaction = async (db: Db, a: Actor, updateId: string, reaction: string, on: boolean) => {
  const { update } = await loadOwnUpdate(db, a, updateId);
  if (on) await react(db, a.ctx.accountId, update.id, a.user.id, reaction);
  else await unreact(db, update.id, a.user.id, reaction);
};

export const setLike = (db: Db, a: Actor, updateId: string, liked: boolean) =>
  setReaction(db, a, updateId, 'like', liked);

/** Item activity tab (07 §12). Guests never see activity (05 §2.1). */
const activityDto = (a: Actor, r: ActivityLogRow, count = 1, undoable = mayUndo(a, r)) => {
  const payload = r.payload as {
    before?: unknown;
    after?: unknown;
    meta?: {
      undo_of?: string;
      via?: string;
      mcp?: { client?: string };
      app?: { name?: string };
      form?: { title?: string };
      workflow_override?: boolean;
    };
  };
  return {
    id: r.id,
    type: r.type,
    actor: r.actorId ? { id: r.actorId, name: r.actorName ?? '' } : null,
    column_id: r.columnKey,
    before: payload.before ?? null,
    after: payload.after ?? null,
    created_at: r.createdAt.toISOString(),
    item_id: r.itemId,
    item_name: r.itemName,
    batch_id: r.batchId,
    count,
    undoable,
    undone: !!r.undoneAt,
    is_undo: !!payload.meta?.undo_of,
    via:
      payload.meta?.via === 'mcp'
        ? { kind: 'mcp' as const, client: payload.meta.mcp?.client ?? null }
        : payload.meta?.via === 'app'
          ? { kind: 'app' as const, client: payload.meta.app?.name ?? null }
          : payload.meta?.via === 'form'
            ? { kind: 'form' as const, client: payload.meta.form?.title ?? null }
            : null,
    // a move made past the status workflow on purpose.
    ...(payload.meta?.workflow_override ? { workflow_override: true } : {}),
  };
};

/** Columns whose values this viewer may not see (05 §6.1): their changes stay out of the activity log too. */
const hiddenColumnIds = async (db: Db, access: BoardAccess, boardIds: string[]) =>
  new Set(
    (await viewRestrictedColumns(db, boardIds))
      .filter((c) => !columnAllowed(access, c.restrictedView))
      .map((c) => c.id),
  );

export const itemActivity = async (db: Db, a: Actor, itemId: string) => {
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guest_restricted');
  const { item, access } = await loadItem(db, a, itemId);
  const hidden = await hiddenColumnIds(db, access, [item.boardId]);
  const rows = await listItemActivity(db, a.ctx.accountId, itemId);
  return rows.filter((r) => !r.columnId || !hidden.has(r.columnId)).map((r) => activityDto(a, r));
};

/** GET /boards/:id/update-counts (N4): `{item id: top-level updates}` for the items this actor may see. */
export const boardUpdateCounts = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const v = await boardVisibility(db, a, access);
  const rows = await updateCountsOf(db, a.ctx.accountId, boardId, visibilitySql(v));
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
};

const BOARD_LOG_PAGE = 100;
const DAY_MS = 86_400_000;

/** The query's filters for the repo: `to` is inclusive (the whole day), `actor_id=system` = nobody by hand. */
const boardLogFilter = (q: BoardActivityQuery) => {
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined;
  const to = q.to ? new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + DAY_MS) : undefined;
  if (from && to && from >= to) throw new AppError('bad_request', 'invalid_range');
  const types = (q.type ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    before: q.before,
    actorId: q.actor_id === ACTIVITY_SYSTEM_ACTOR ? null : q.actor_id || undefined,
    columnKey: q.column || undefined,
    types: types.length ? types : undefined,
    from,
    to,
    q: q.q || undefined,
  };
};

/**
 * GET /boards/:id/activity (07 §12, Ctrl+Shift+L): the board's and its subitems' events, newest first, only on
 * items the viewer may see; the events of one batch (a bulk action, a paste) are one row with their count —
 * undoing it undoes the batch.
 */
export const boardActivity = async (db: Db, a: Actor, boardId: string, query: BoardActivityQuery = {}) => {
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guest_restricted');
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  const sub = await findSubBoard(db, boardId);
  const rows = await listBoardActivity(
    db,
    a.ctx.accountId,
    sub ? [boardId, sub.id] : [boardId],
    BOARD_LOG_PAGE,
    boardLogFilter(query),
  );
  const hidden = await hiddenColumnIds(db, access, sub ? [boardId, sub.id] : [boardId]);
  const itemIds = [...new Set(rows.flatMap((r) => (r.itemId ? [r.itemId] : [])))];
  const visible = await visibleAcrossBoards(db, a, await itemsByIds(db, a.ctx.accountId, itemIds));
  const out: ReturnType<typeof activityDto>[] = [];
  const batches = new Map<string, { at: number; rows: ActivityLogRow[] }>();
  for (const r of rows) {
    if (r.itemId && !visible.has(r.itemId)) continue;
    if (r.columnId && hidden.has(r.columnId)) continue;
    if (!r.batchId) {
      out.push(activityDto(a, r));
      continue;
    }
    const b = batches.get(r.batchId);
    if (b) b.rows.push(r);
    else {
      batches.set(r.batchId, { at: out.length, rows: [r] });
      out.push(activityDto(a, r)); // replaced below by the batch's row
    }
  }
  for (const { at, rows: group } of batches.values()) {
    if (group.length === 1) continue;
    // A bulk action also writes a summary event (no item): the row shows an item's event and counts items.
    const first = group.find((g) => g.itemId) ?? group[0]!;
    const count = new Set(group.flatMap((g) => (g.itemId ? [g.itemId] : []))).size || group.length;
    // Undoable as one when every undoable event of it still is (the server undoes the whole batch).
    const undoable = group.filter((g) => isUndoable(g)).every((g) => mayUndo(a, g));
    out[at] = {
      ...activityDto(a, first, count, undoable),
      item_id: null,
      item_name: group
        .map((g) => g.itemName)
        .filter(Boolean)
        .slice(0, 3)
        .join(', '),
    };
  }
  return { data: out, next_before: rows.length === BOARD_LOG_PAGE ? rows.at(-1)!.id : null };
};
