// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  canDoc,
  columnTypes,
  type createDocSchema,
  deriveValues,
  DOC_FAVORITES_MAX,
  docSettingsSchema,
  type DocLevel,
  type FavoriteDocs,
  newId,
  rankBetween,
  type RichNode,
  type setDocMembersSchema,
  type updateDocSchema,
  type WorkspaceEntity,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AccountContext, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { findMembership } from '../accounts/accounts.repo';
import { positionAmong, rankBetweenOrAfter, workspaceVisibleTo } from '../boards/boards.access';
import { updateItemRow, upsertCell } from '../items/items.repo';
import {
  findColumnById,
  findFolder,
  findWorkspace,
  lastBoardPosition,
  lastFolderPosition,
  listBoardsInWorkspace,
  listFolders,
  workspaceIdsWithMember,
} from '../boards/boards.repo';
import { memberSettings, setMemberSettings } from '../mywork/mywork.repo';
import { findTeam } from '../teams/teams.repo';
import { syncFileCell } from '../files/files.service';
import { trashObject } from '../trash/trash.service';
import { lastDashboardPosition, listDashboardsInWorkspace } from '../dashboards/dashboards.repo';
import { assertDoc, canOpenDoc, type DocAccess, docCapabilitiesOf, loadDocAccess, readableDocs } from './docs.access';
import { auditGuestShare, auditKindChange, guestsAmong, notifyShared } from '../sharing/sharing';
import {
  type DocMeta,
  docsByIds,
  insertDoc,
  insertDocMembers,
  lastDocPosition,
  listDocMembers,
  listDocsInWorkspace,
  loadDocContent,
  loadDocState,
  openThreadCount,
  openThreadCounts,
  replaceDocMembers,
  setDocAssets,
  updateDocRow,
  userNames,
} from './docs.repo';
import { decodeState, deriveDoc, encodeState, jsonToYdoc } from './ydoc';
import { accountLocale, st } from '../../lib/i18n';

/** Who may create docs (like boards and folders): members and admins of the account. */
const canCreateStructure = (ctx: AccountContext) => ctx.role === 'admin' || ctx.role === 'member';

/** The Hocuspocus document name of a doc: account first, so a connection can never name another account's doc. */
export const collabName = (accountId: string, docId: string) => `${accountId}:${docId}`;

export const docSummaryDto = (d: DocMeta) => ({
  id: d.id,
  name: d.name,
  icon: d.icon,
  kind: d.kind,
  workspace_id: d.workspaceId,
  folder_id: d.folderId,
  position: d.position,
});

const docDetail = async (db: Db, access: DocAccess) => {
  const d = access.doc;
  const names = await userNames(
    db,
    [d.createdBy, d.updatedBy].filter((x): x is string => !!x),
  );
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null);
  const cell = access.cell;
  return {
    ...docSummaryDto(d),
    settings: docSettingsSchema.catch({}).parse(d.settings ?? {}),
    revision: d.revision,
    capabilities: docCapabilitiesOf(access),
    created_at: d.createdAt.toISOString(),
    created_by: person(d.createdBy),
    updated_at: d.updatedAt.toISOString(),
    updated_by: person(d.updatedBy),
    collab_name: collabName(d.accountId, d.id),
    host: d.host,
    cell: cell
      ? {
          // The board the item opens on (a subitem's parent board — D14).
          board_id: cell.board.board.parentBoardId ?? cell.item.boardId,
          item_id: cell.item.id,
          item_name: cell.item.name,
          column_key: cell.columnKey,
        }
      : null,
    open_threads: await openThreadCount(db, d.id),
  };
};

/**
 * The docs of a workspace as sidebar rows (M8 ד0's `entities`), only those the actor may read — with what they may
 * do to each.
 */
export const workspaceDocEntities = async (db: Db, a: Actor, workspaceId: string): Promise<WorkspaceEntity[]> => {
  const readable = await readableDocs(db, a.ctx, a.user, await listDocsInWorkspace(db, a.ctx.accountId, workspaceId));
  const threads = await openThreadCounts(
    db,
    readable.map((r) => r.doc.id),
  );
  return readable.map(({ doc, perm }) => ({
    type: 'doc' as const,
    ...docSummaryDto(doc),
    can_update: canDoc(perm, 'doc.manage').ok,
    can_delete: canDoc(perm, 'doc.manage').ok,
    open_threads: threads.get(doc.id) ?? 0,
  }));
};

/** GET /workspaces/:id/docs. */
export const listWorkspaceDocs = async (db: Db, a: Actor, workspaceId: string) => {
  const workspace = await findWorkspace(db, a.ctx.accountId, workspaceId);
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  if (!workspace || !workspaceVisibleTo(workspace, a.ctx, memberOf)) throw new AppError('not_found', 'Not found');
  return (await readableDocs(db, a.ctx, a.user, await listDocsInWorkspace(db, a.ctx.accountId, workspaceId))).map(
    ({ doc }) => docSummaryDto(doc),
  );
};

/**
 * The last place among the boards, docs, dashboards and sub-folders of a folder (they share one order in the sidebar
 * sub-folders too since): something new goes last.
 */
export const lastEntityPosition = async (db: Db, workspaceId: string, folderId: string | null) => {
  const [b, d, s, f] = await Promise.all([
    lastBoardPosition(db, workspaceId, folderId),
    lastDocPosition(db, workspaceId, folderId),
    lastDashboardPosition(db, workspaceId, folderId),
    lastFolderPosition(db, workspaceId, folderId),
  ]);
  return (
    [b, d, s, f]
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null
  );
};

/** Boards, docs and dashboards of one folder (or the root), in sidebar order — what a dragged row lands among. */
export const folderSiblings = async (db: Db, accountId: string, workspaceId: string, folderId: string | null) => {
  const [boards, docs, dashboards, folders] = await Promise.all([
    listBoardsInWorkspace(db, accountId, workspaceId),
    listDocsInWorkspace(db, accountId, workspaceId),
    listDashboardsInWorkspace(db, accountId, workspaceId),
    listFolders(db, accountId, workspaceId),
  ]);
  return [
    ...[...boards, ...docs, ...dashboards].filter((x) => x.folderId === folderId),
    // its sub-folders stand in the same order (a folder may sit between boards).
    ...folders.filter((f) => f.parentFolderId === folderId).map((f) => ({ ...f, isFolder: true })),
  ]
    .map((x) => ({ id: x.id, position: x.position, folder: 'isFolder' in x }))
    .sort((p, q) => (p.position < q.position ? -1 : p.position > q.position ? 1 : 0));
};

/**
 * Where a new folder goes: right after the last folder of its parent (or the root) — where the
 * folders are until someone drags one elsewhere — or, with none, first.
 */
export const newFolderPosition = async (db: Db, accountId: string, workspaceId: string, parentId: string | null) => {
  const siblings = await folderSiblings(db, accountId, workspaceId, parentId);
  const i = siblings.findLastIndex((x) => x.folder);
  return rankBetweenOrAfter(siblings[i]?.position ?? null, siblings[i + 1]?.position ?? null);
};

/** POST /workspaces/:id/docs — an empty doc, last in its folder; its creator owns it. */
export const createDoc = async (db: Db, a: Actor, workspaceId: string, input: z.infer<typeof createDocSchema>) => {
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_doc');
  const workspace = await findWorkspace(db, a.ctx.accountId, workspaceId);
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  if (!workspace || !workspaceVisibleTo(workspace, a.ctx, memberOf)) throw new AppError('not_found', 'Not found');
  const folderId = input.folder_id ?? null;
  if (folderId) {
    const folder = await findFolder(db, a.ctx.accountId, folderId);
    if (!folder || folder.workspaceId !== workspace.id) throw new AppError('not_found', 'Folder not found');
  }
  const id = newId();
  // The client sends the localized name; without one, the account's language.
  const name = input.name ?? st('server.newDoc', undefined, await accountLocale(db, a.ctx.accountId));
  await db.transaction(async (tx) => {
    await insertDoc(tx, {
      id,
      accountId: a.ctx.accountId,
      workspaceId: workspace.id,
      folderId,
      position: rankBetween(await lastEntityPosition(tx, workspace.id, folderId), null),
      kind: input.kind,
      name,
      createdBy: a.user.id,
      updatedBy: a.user.id,
    });
    await insertDocMembers(tx, [
      { id: newId(), docId: id, accountId: a.ctx.accountId, userId: a.user.id, level: 'owner', addedBy: a.user.id },
    ]);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.created',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id, name, kind: input.kind, workspace_id: workspace.id, folder_id: folderId },
      meta: { doc_id: id },
    });
  });
  return getDoc(db, a, id);
};

export const getDoc = async (db: Db, a: Actor, docId: string) =>
  docDetail(db, await loadDocAccess(db, a.ctx, a.user, docId));

/** GET /docs/:id/content — the derived JSON + text (no WebSocket needed). */
export const getDocContent = async (db: Db, a: Actor, docId: string) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  const row = (await loadDocContent(db, a.ctx.accountId, docId))!;
  return {
    id: docId,
    revision: row.revision,
    content: (row.content as RichNode | null) ?? null,
    text: row.text,
    updated_at: (row.updatedAt ?? access.doc.updatedAt).toISOString(),
  };
};

/** The workspace a doc moves into: one I see, where I may create — or 404 / 403. */
const loadMoveTarget = async (db: Db, a: Actor, workspaceId: string) => {
  const target = await findWorkspace(db, a.ctx.accountId, workspaceId);
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  if (!target || !workspaceVisibleTo(target, a.ctx, memberOf)) throw new AppError('not_found', 'Workspace not found');
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_doc');
  return target;
};

/**
 * PATCH /docs/:id. Name, icon, folder, place and settings: whoever manages it (its owners, admins). Kind and
 * workspace too — the access of everyone connected is checked again (the collab server reconnects them).
 */
export const updateDoc = async (db: Db, a: Actor, docId: string, input: z.infer<typeof updateDocSchema>) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.manage');
  const d = access.doc;
  // A cell doc lives in its item: no kind, place or workspace of its own; its name is the cell's text.
  if (
    access.cell &&
    (input.kind || input.workspace_id || input.folder_id !== undefined || input.position !== undefined)
  )
    throw new AppError('bad_request', 'cell_doc');
  let workspaceId = d.workspaceId;
  if (input.workspace_id && input.workspace_id !== d.workspaceId)
    workspaceId = (await loadMoveTarget(db, a, input.workspace_id)).id;
  const movedWorkspace = workspaceId !== d.workspaceId;
  const folderId = input.folder_id !== undefined ? input.folder_id : movedWorkspace ? null : d.folderId;
  if (folderId && (input.folder_id !== undefined || movedWorkspace)) {
    const folder = await findFolder(db, a.ctx.accountId, folderId);
    if (!folder || folder.workspaceId !== workspaceId) throw new AppError('not_found', 'Folder not found');
  }
  let position: string | undefined;
  if (input.position) {
    const siblings = (await folderSiblings(db, a.ctx.accountId, workspaceId, folderId)).filter((x) => x.id !== d.id);
    position = positionAmong(siblings, input.position);
  } else if (movedWorkspace || folderId !== d.folderId) {
    position = rankBetween(await lastEntityPosition(db, workspaceId, folderId), null);
  }
  const settings = input.settings
    ? { ...(d.settings as Record<string, unknown>), ...docSettingsSchema.parse(input.settings) }
    : undefined;
  await db.transaction(async (tx) => {
    await updateDocRow(tx, d.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(movedWorkspace ? { workspaceId } : {}),
      ...(folderId !== d.folderId ? { folderId } : {}),
      ...(position ? { position } : {}),
      ...(settings ? { settings } : {}),
    });
    if (access.cell && input.name && input.name !== d.name) {
      await syncCellName(tx, a, access, input.name);
      // The board's row shows the new name (a row event for the open boards).
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'cell.doc_renamed',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: d.boardId,
        itemId: d.itemId,
        columnId: d.columnId,
        before: { value: { doc_id: d.id, name: d.name } },
        after: { value: { doc_id: d.id, name: input.name } },
        meta: { doc_id: d.id, column_key: access.cell.columnKey },
      });
    }
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: movedWorkspace ? 'doc.moved' : 'doc.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      before: {
        id: d.id,
        name: d.name,
        icon: d.icon,
        kind: d.kind,
        workspace_id: d.workspaceId,
        folder_id: d.folderId,
        position: d.position,
      },
      after: { id: d.id, ...input, ...(position ? { position } : {}) },
      meta: { doc_id: d.id, access_changed: !!input.kind || movedWorkspace },
    });
    if (input.kind)
      await auditKindChange(tx, {
        accountId: a.ctx.accountId,
        actorId: a.user.id,
        object: { type: 'doc', id: d.id, name: d.name },
        from: d.kind,
        to: input.kind,
      });
  });
  return getDoc(db, a, docId);
};

/** A cell doc's cell holds `{doc_id, name}`; its text (search, sort, export) is the doc's name. */
export const writeDocCell = async (
  tx: Db,
  a: Actor,
  doc: { id: string; itemId: string | null; columnId: string | null; boardId: string | null },
  name: string,
) => {
  if (!doc.itemId || !doc.columnId || !doc.boardId) return;
  const column = await findColumnById(tx, doc.columnId);
  const def = column ? columnTypes.get(column.type) : undefined;
  if (!column || !def) return;
  // A doc in a file column's cell (Fix: ): the cell lists its files and docs — rebuilt from them.
  if (def.engine === 'files') {
    await syncFileCell(tx, a, doc.itemId, doc.boardId, doc.columnId);
    await updateItemRow(tx, doc.itemId, { lastCellChangeAt: new Date(), lastCellChangeBy: a.user.id });
    return;
  }
  const value = { doc_id: doc.id, name };
  const d = deriveValues(def, column.settings, value);
  await upsertCell(tx, {
    itemId: doc.itemId,
    columnId: doc.columnId,
    accountId: a.ctx.accountId,
    boardId: doc.boardId,
    value,
    textValue: d.textValue,
    numberValue: d.numberValue,
    dateValue: null,
    dateEndValue: null,
    updatedBy: a.user.id,
    updatedByType: 'user',
  });
  await updateItemRow(tx, doc.itemId, { lastCellChangeAt: new Date(), lastCellChangeBy: a.user.id });
};

/** A cell doc of a `file` column (several per cell, removable) — not of a `doc` column. */
const inFileColumn = async (db: Db, access: DocAccess) => {
  const column = access.doc.columnId ? await findColumnById(db, access.doc.columnId) : undefined;
  return !!column && columnTypes.get(column.type)?.engine === 'files';
};

const syncCellName = (tx: Db, a: Actor, access: DocAccess, name: string) => writeDocCell(tx, a, access.doc, name);

/** DELETE /docs/:id — to trash (30 days, restore / undo like any object). */
export const deleteDoc = async (db: Db, a: Actor, docId: string) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.manage');
  // A doc column's doc goes with its item (trash, archive), never alone; one of a file column's docs is removed
  // from its cell like a file (Fix: ) — to the trash, and back into the cell on restore.
  const fileCell = access.cell ? await inFileColumn(db, access) : false;
  if (access.cell && !fileCell) throw new AppError('bad_request', 'cell_doc');
  const d = access.doc;
  return db.transaction(async (tx) => {
    await updateDocRow(tx, d.id, { deletedAt: new Date() });
    if (fileCell && d.itemId && d.boardId && d.columnId) await syncFileCell(tx, a, d.itemId, d.boardId, d.columnId);
    const entryId = await trashObject(tx, a, { type: 'doc', id: d.id, name: d.name });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id: d.id, name: d.name, workspace_id: d.workspaceId, folder_id: d.folderId },
      meta: { trash_entry_id: entryId, doc_id: d.id, access_changed: true },
    });
  });
};

/**
 * POST /docs/:id/duplicate — the content (its Yjs state as it is saved now) right after the original; the one who
 * duplicates owns the copy (like a board's duplicate), the original's members are not copied.
 */
export const duplicateDoc = async (db: Db, a: Actor, docId: string, input: { name?: string }) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_doc');
  if (access.cell) throw new AppError('bad_request', 'cell_doc');
  const d = access.doc;
  const state = await loadDocState(db, a.ctx.accountId, d.id);
  const id = newId();
  const name = input.name ?? `${d.name} (2)`;
  const siblings = await folderSiblings(db, a.ctx.accountId, d.workspaceId, d.folderId);
  const position = positionAmong(siblings, { after_id: d.id });
  // An old row may hold content without a Yjs state (an import): the copy gets a state made from it.
  const ydoc = state?.ydoc?.length
    ? state.ydoc
    : state?.content
      ? encodeState(jsonToYdoc(state.content as RichNode))
      : null;
  const derived = ydoc ? deriveDoc(decodeState(ydoc)) : null;
  await db.transaction(async (tx) => {
    await insertDoc(tx, {
      id,
      accountId: a.ctx.accountId,
      workspaceId: d.workspaceId,
      folderId: d.folderId,
      position,
      kind: d.kind,
      name,
      icon: d.icon,
      settings: d.settings,
      ydoc,
      content: derived?.content ?? null,
      textValue: derived?.text ?? '',
      createdBy: a.user.id,
      updatedBy: a.user.id,
    });
    await insertDocMembers(tx, [
      { id: newId(), docId: id, accountId: a.ctx.accountId, userId: a.user.id, level: 'owner', addedBy: a.user.id },
    ]);
    if (derived?.assetIds.length) await setDocAssets(tx, { accountId: a.ctx.accountId, id }, derived.assetIds);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.duplicated',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id: d.id, name: d.name },
      after: { id, name },
      meta: { doc_id: id, source_doc_id: d.id },
    });
  });
  return getDoc(db, a, id);
};

// ---- members ----
export const getDocMembers = async (db: Db, a: Actor, docId: string) => {
  await loadDocAccess(db, a.ctx, a.user, docId);
  return {
    data: (await listDocMembers(db, docId)).map((m) =>
      m.userId
        ? { type: 'user' as const, id: m.userId, name: m.userName ?? '', email: m.email ?? null, level: m.level }
        : { type: 'team' as const, id: m.teamId!, name: m.teamName ?? '', email: null, level: m.level },
    ),
  };
};

/**
 * PUT /docs/:id/members — the whole list (05: owners and admins). Every person must be an active member of the
 * account (a guest only on a shareable doc), every team the account's; a doc always keeps a person who owns it.
 */
export const setDocMembers = async (db: Db, a: Actor, docId: string, input: z.infer<typeof setDocMembersSchema>) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.manage');
  // A cell doc has its item's people: share the board instead.
  if (access.cell) throw new AppError('bad_request', 'cell_doc');
  const seen = new Set<string>();
  const rows: { type: 'user' | 'team'; id: string; level: DocLevel }[] = [];
  for (const m of input.members) {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.type === 'user') {
      const membership = await findMembership(db, a.ctx.accountId, m.id);
      if (!membership || membership.status === 'deactivated')
        throw new AppError('validation_failed', 'Not a member of the account', { user_id: m.id });
      if (membership.role === 'guest' && access.doc.kind !== 'shareable')
        throw new AppError('validation_failed', 'guests_only_on_shareable', { user_id: m.id });
    } else if (!(await findTeam(db, a.ctx.accountId, m.id))) {
      throw new AppError('validation_failed', 'Team not found', { team_id: m.id });
    }
    rows.push(m);
  }
  if (!rows.some((r) => r.type === 'user' && r.level === 'owner'))
    throw new AppError('validation_failed', 'doc_needs_owner');
  const before = (await getDocMembers(db, a, docId)).data.map((m) => ({ type: m.type, id: m.id, level: m.level }));
  const beforeUsers = new Set(before.filter((m) => m.type === 'user').map((m) => m.id));
  const afterUsers = new Set(rows.filter((r) => r.type === 'user').map((r) => r.id));
  const guests = await guestsAmong(db, a.ctx.accountId, [...beforeUsers, ...afterUsers]);
  const object = { type: 'doc' as const, id: docId, name: access.doc.name };
  await db.transaction(async (tx) => {
    await replaceDocMembers(
      tx,
      rows.map((r) => ({
        id: newId(),
        docId,
        accountId: a.ctx.accountId,
        userId: r.type === 'user' ? r.id : null,
        teamId: r.type === 'team' ? r.id : null,
        level: r.level,
        addedBy: a.user.id,
      })),
      docId,
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'doc.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id: docId, members: before },
      after: { id: docId, members: rows },
      meta: { doc_id: docId, access_changed: true },
    });
    // Shared with someone new: they hear about it; a guest's access is audited.
    const added = rows.filter((r) => r.type === 'user' && !beforeUsers.has(r.id));
    await auditGuestShare(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      object,
      added: added.filter((r) => guests.has(r.id)).map((r) => ({ userId: r.id, level: r.level })),
      removed: [...beforeUsers].filter((u) => guests.has(u) && !afterUsers.has(u)),
    });
    await notifyShared(
      tx,
      a.ctx.account,
      object,
      a.user.id,
      added.map((r) => r.id),
      canOpenDoc(docId),
    );
  });
  return getDocMembers(db, a, docId);
};

// ---- collab token ----
/** Short-lived (5 minutes) proof to open one doc's WebSocket without the session cookie (another origin, a test). */
const TOKEN_TTL_MS = 5 * 60_000;
let fallbackSecret: string | null = null;
const tokenSecret = (secret: string | undefined) => secret ?? (fallbackSecret ??= randomBytes(32).toString('hex'));
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64url');

export const issueCollabToken = async (
  db: Db,
  a: Actor,
  docId: string,
  secret: string | undefined,
  now = Date.now(),
) => {
  await loadDocAccess(db, a.ctx, a.user, docId);
  const exp = now + TOKEN_TTL_MS;
  const body = Buffer.from(JSON.stringify({ u: a.user.id, a: a.ctx.accountId, d: docId, e: exp })).toString(
    'base64url',
  );
  return { token: `${body}.${sign(tokenSecret(secret), body)}`, expires_at: new Date(exp).toISOString() };
};

/** The user, account and doc a collab token was issued for — null when forged, expired or for another doc. */
export const verifyCollabToken = (token: string, secret: string | undefined, now = Date.now()) => {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(tokenSecret(secret), body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      u: string;
      a: string;
      d: string;
      e: number;
    };
    return typeof p.e === 'number' && p.e > now ? { userId: p.u, accountId: p.a, docId: p.d } : null;
  } catch {
    return null;
  }
};

// ---- favourites ----
const storedFavoriteIds = async (db: Db, a: Actor) => {
  const v = ((await memberSettings(db, a.ctx.accountId, a.user.id)) as { favorite_docs?: unknown }).favorite_docs;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

const resolveFavorites = async (db: Db, a: Actor, ids: string[]): Promise<FavoriteDocs['data']> => {
  const readable = await readableDocs(db, a.ctx, a.user, await docsByIds(db, a.ctx.accountId, ids));
  const byId = new Map(readable.map((r) => [r.doc.id, r.doc]));
  return ids.flatMap((id) => {
    const d = byId.get(id);
    return d ? [{ id: d.id, name: d.name, workspace_id: d.workspaceId }] : [];
  });
};

/** GET /me/favorite-docs — my starred docs (that still exist and that I may still open), in my order. */
export const favoriteDocs = async (db: Db, a: Actor) => ({
  data: await resolveFavorites(db, a, await storedFavoriteIds(db, a)),
});

/** PUT /me/favorite-docs — the whole list, in order; personal, so no activity event (like favourite boards). */
export const setFavoriteDocs = async (db: Db, a: Actor, docIds: string[]) => {
  const data = await resolveFavorites(db, a, [...new Set(docIds)].slice(0, DOC_FAVORITES_MAX));
  const all = (await memberSettings(db, a.ctx.accountId, a.user.id)) as Record<string, unknown>;
  await setMemberSettings(db, a.ctx.accountId, a.user.id, { ...all, favorite_docs: data.map((d) => d.id) });
  return { data };
};
