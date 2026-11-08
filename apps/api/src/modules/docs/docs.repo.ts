// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { type DocLevel, higherDocLevel } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  docAssets,
  docComments,
  docCommentThreads,
  docMembers,
  docs,
  docVersions,
  teamMembers,
  teams,
  users,
} from '../../db/schema';

export type DocRow = typeof docs.$inferSelect;
export type DocMemberRow = typeof docMembers.$inferSelect;

/** Everything but the Yjs state (it can be megabytes — read only by the collab server and duplicate). */
const meta = {
  id: docs.id,
  accountId: docs.accountId,
  workspaceId: docs.workspaceId,
  folderId: docs.folderId,
  position: docs.position,
  kind: docs.kind,
  host: docs.host,
  boardId: docs.boardId,
  itemId: docs.itemId,
  columnId: docs.columnId,
  name: docs.name,
  icon: docs.icon,
  coverAssetId: docs.coverAssetId,
  settings: docs.settings,
  revision: docs.revision,
  createdBy: docs.createdBy,
  updatedBy: docs.updatedBy,
  createdAt: docs.createdAt,
  updatedAt: docs.updatedAt,
  archivedAt: docs.archivedAt,
  deletedAt: docs.deletedAt,
  sourceDocId: docs.sourceDocId,
};
export type DocMeta = Omit<DocRow, 'ydoc' | 'content' | 'textValue'>;

const live = and(isNull(docs.deletedAt), isNull(docs.archivedAt));

/** A live doc of the account (not in trash). */
export const findDoc = async (db: Db, accountId: string, id: string): Promise<DocMeta | undefined> =>
  (
    await db
      .select(meta)
      .from(docs)
      .where(and(eq(docs.accountId, accountId), eq(docs.id, id), live))
      .limit(1)
  )[0];

/** A doc in or out of trash (restore, purge). */
export const anyDoc = async (db: Db, id: string): Promise<DocMeta | undefined> =>
  (await db.select(meta).from(docs).where(eq(docs.id, id)).limit(1))[0];

/** The sidebar docs of a workspace (cell docs never show there), in sidebar order. */
export const listDocsInWorkspace = (db: Db, accountId: string, workspaceId: string): Promise<DocMeta[]> =>
  db
    .select(meta)
    .from(docs)
    .where(and(eq(docs.accountId, accountId), eq(docs.workspaceId, workspaceId), eq(docs.host, 'workspace'), live))
    .orderBy(asc(docs.position));

export const docsByIds = (db: Db, accountId: string, ids: string[]): Promise<DocMeta[]> =>
  ids.length
    ? db
        .select(meta)
        .from(docs)
        .where(and(eq(docs.accountId, accountId), inArray(docs.id, ids), live))
    : Promise.resolve([]);

/**
 * Live sidebar docs whose name or text matches `pattern` (an ILIKE pattern of `q`): name hits first, then the most
 * recently edited. Each carries `around` — up to 600 characters of its text from just before the first match of `q`
 * (its start when only the name matched), so a long doc is never read whole. The caller keeps the readable ones.
 */
export const docTextHits = (db: Db, accountId: string, q: string, pattern: string, limit: number) =>
  db
    .select({
      ...meta,
      around: sql<string>`substr(${docs.textValue}, greatest(1, strpos(lower(${docs.textValue}), lower(${q})) - 150), 600)`,
    })
    .from(docs)
    .where(
      and(
        eq(docs.accountId, accountId),
        eq(docs.host, 'workspace'),
        live,
        or(ilike(docs.name, pattern), ilike(docs.textValue, pattern)),
      ),
    )
    .orderBy(desc(sql`${docs.name} ilike ${pattern}`), desc(docs.updatedAt))
    .limit(limit);

export const countDocsInWorkspace = async (db: Db, workspaceId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(docs)
      .where(and(eq(docs.workspaceId, workspaceId), isNull(docs.deletedAt)))
  )[0]?.n ?? 0;

export const lastDocPosition = async (db: Db, workspaceId: string, folderId: string | null) =>
  (
    await db
      .select({ p: docs.position })
      .from(docs)
      .where(
        and(
          eq(docs.workspaceId, workspaceId),
          folderId ? eq(docs.folderId, folderId) : isNull(docs.folderId),
          isNull(docs.deletedAt),
        ),
      )
      .orderBy(desc(docs.position))
      .limit(1)
  )[0]?.p ?? null;

export const insertDoc = (db: Db, row: typeof docs.$inferInsert) => db.insert(docs).values(row);

export const updateDocRow = (db: Db, id: string, patch: Partial<typeof docs.$inferInsert>) =>
  db
    .update(docs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(docs.id, id));

/** Docs of these folders go to the workspace root (the folder went to trash); returns what moved, and from where. */
export const moveDocsToRoot = (db: Db, folderIds: string[]) =>
  folderIds.length
    ? db
        .update(docs)
        .set({ folderId: null, updatedAt: new Date() })
        .where(and(inArray(docs.folderId, folderIds), isNull(docs.deletedAt)))
        .returning({ id: docs.id })
    : Promise.resolve([]);

/** Docs of these folders follow them to another workspace (fix8's folder move). */
export const moveDocsOfFolders = (db: Db, accountId: string, folderIds: string[], workspaceId: string) =>
  folderIds.length
    ? db
        .update(docs)
        .set({ workspaceId, updatedAt: new Date() })
        .where(and(eq(docs.accountId, accountId), inArray(docs.folderId, folderIds)))
    : Promise.resolve();

export const returnDocsToFolder = (db: Db, ids: string[], folderId: string) =>
  ids.length
    ? db
        .update(docs)
        .set({ folderId, updatedAt: new Date() })
        // Only those still at the root: one moved elsewhere since stays where it was put.
        .where(and(inArray(docs.id, ids), isNull(docs.folderId), isNull(docs.deletedAt)))
    : Promise.resolve();

// ---- Yjs state ----
export const loadDocState = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select({ ydoc: docs.ydoc, content: docs.content, deletedAt: docs.deletedAt })
      .from(docs)
      .where(and(eq(docs.accountId, accountId), eq(docs.id, id)))
      .limit(1)
  )[0];

export const loadDocContent = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select({ content: docs.content, text: docs.textValue, revision: docs.revision, updatedAt: docs.updatedAt })
      .from(docs)
      .where(and(eq(docs.accountId, accountId), eq(docs.id, id)))
      .limit(1)
  )[0];

/** One save of the collab server: the state, what is derived from it, the files it shows. */
export const storeDocState = async (
  db: Db,
  doc: { accountId: string; id: string },
  s: { ydoc: Uint8Array; content: Record<string, unknown>; text: string; assetIds: string[]; userId: string | null },
) => {
  await db
    .update(docs)
    .set({
      ydoc: s.ydoc,
      content: s.content,
      textValue: s.text,
      revision: sql`${docs.revision} + 1`,
      updatedAt: new Date(),
      ...(s.userId ? { updatedBy: s.userId } : {}),
    })
    .where(and(eq(docs.accountId, doc.accountId), eq(docs.id, doc.id)));
  await setDocAssets(db, doc, s.assetIds);
};

export const setDocAssets = async (db: Db, doc: { accountId: string; id: string }, assetIds: string[]) => {
  await db.delete(docAssets).where(eq(docAssets.docId, doc.id));
  if (!assetIds.length) return;
  // Only files of this account (an id pasted from elsewhere protects nothing).
  await db.execute(sql`
    insert into doc_assets (doc_id, asset_id, account_id)
    select ${doc.id}, a.id, a.account_id from assets a
    where a.account_id = ${doc.accountId} and a.id in (${sql.join(
      assetIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    on conflict do nothing`);
};

// ---- members ----
/** Doc → the actor's highest level, personally or through a team (one query for many docs). */
export const docLevelsOf = async (
  db: Db,
  accountId: string,
  userId: string,
  docIds?: string[],
): Promise<Map<string, DocLevel>> => {
  if (docIds && !docIds.length) return new Map();
  const rows = await db
    .select({ docId: docMembers.docId, level: docMembers.level })
    .from(docMembers)
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, docMembers.teamId), eq(teamMembers.userId, userId)))
    .leftJoin(teams, eq(teams.id, docMembers.teamId))
    .where(
      and(
        eq(docMembers.accountId, accountId),
        or(eq(docMembers.userId, userId), and(isNotNull(teamMembers.userId), isNull(teams.deletedAt))),
        docIds ? inArray(docMembers.docId, docIds) : undefined,
      ),
    );
  const out = new Map<string, DocLevel>();
  for (const r of rows) out.set(r.docId, higherDocLevel(out.get(r.docId) ?? null, r.level)!);
  return out;
};

export const listDocMembers = (db: Db, docId: string) =>
  db
    .select({
      userId: docMembers.userId,
      teamId: docMembers.teamId,
      level: docMembers.level,
      userName: users.name,
      email: users.email,
      teamName: teams.name,
    })
    .from(docMembers)
    .leftJoin(users, eq(users.id, docMembers.userId))
    .leftJoin(teams, eq(teams.id, docMembers.teamId))
    .where(eq(docMembers.docId, docId))
    .orderBy(asc(docMembers.createdAt));

export const replaceDocMembers = async (db: Db, rows: (typeof docMembers.$inferInsert)[], docId: string) => {
  await db.delete(docMembers).where(eq(docMembers.docId, docId));
  if (rows.length) await db.insert(docMembers).values(rows);
};

export const insertDocMembers = (db: Db, rows: (typeof docMembers.$inferInsert)[]) =>
  rows.length ? db.insert(docMembers).values(rows).onConflictDoNothing() : Promise.resolve();

export const docMemberRows = (db: Db, docId: string) => db.select().from(docMembers).where(eq(docMembers.docId, docId));

/** Names of users (created_by / updated_by). */
export const userNames = async (db: Db, ids: string[]) =>
  new Map(
    (ids.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : []
    ).map((u) => [u.id, u.name]),
  );

// ---- versions (ד3) ----
export const insertDocVersion = (db: Db, row: typeof docVersions.$inferInsert) => db.insert(docVersions).values(row);

/** Newest first, without the states (a list). */
export const listDocVersions = (db: Db, docId: string, limit = 200) =>
  db
    .select({
      id: docVersions.id,
      label: docVersions.label,
      auto: docVersions.auto,
      createdAt: docVersions.createdAt,
      createdBy: docVersions.createdBy,
    })
    .from(docVersions)
    .where(eq(docVersions.docId, docId))
    .orderBy(desc(docVersions.createdAt), desc(docVersions.id))
    .limit(limit);

export const findDocVersion = async (db: Db, docId: string, id: string) =>
  (
    await db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.docId, docId), eq(docVersions.id, id)))
      .limit(1)
  )[0];

export const lastDocVersionAt = async (db: Db, docId: string) =>
  (
    await db
      .select({ at: docVersions.createdAt })
      .from(docVersions)
      .where(eq(docVersions.docId, docId))
      .orderBy(desc(docVersions.createdAt))
      .limit(1)
  )[0]?.at ?? null;

/** Automatic versions older than `before` go (named ones stay forever). */
export const purgeAutoVersions = (db: Db, accountId: string, before: Date) =>
  db
    .delete(docVersions)
    .where(and(eq(docVersions.accountId, accountId), eq(docVersions.auto, true), lt(docVersions.createdAt, before)));

// ---- comments (ד3) ----
export type ThreadRow = typeof docCommentThreads.$inferSelect;
export type CommentRow = typeof docComments.$inferSelect;

export const insertThread = (db: Db, row: typeof docCommentThreads.$inferInsert) =>
  db.insert(docCommentThreads).values(row);
export const insertComment = (db: Db, row: typeof docComments.$inferInsert) => db.insert(docComments).values(row);

export const listThreads = (db: Db, docId: string) =>
  db
    .select()
    .from(docCommentThreads)
    .where(and(eq(docCommentThreads.docId, docId), isNull(docCommentThreads.deletedAt)))
    .orderBy(asc(docCommentThreads.createdAt));

export const listComments = (db: Db, docId: string) =>
  db
    .select()
    .from(docComments)
    .where(and(eq(docComments.docId, docId), isNull(docComments.deletedAt)))
    .orderBy(asc(docComments.createdAt), asc(docComments.id));

export const findThread = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(docCommentThreads)
      .where(
        and(
          eq(docCommentThreads.accountId, accountId),
          eq(docCommentThreads.id, id),
          isNull(docCommentThreads.deletedAt),
        ),
      )
      .limit(1)
  )[0];

export const findComment = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(docComments)
      .where(and(eq(docComments.accountId, accountId), eq(docComments.id, id), isNull(docComments.deletedAt)))
      .limit(1)
  )[0];

export const updateThread = (db: Db, id: string, patch: Partial<typeof docCommentThreads.$inferInsert>) =>
  db.update(docCommentThreads).set(patch).where(eq(docCommentThreads.id, id));

export const updateComment = (db: Db, id: string, patch: Partial<typeof docComments.$inferInsert>) =>
  db.update(docComments).set(patch).where(eq(docComments.id, id));

/** Live comments of a thread (its participants, whether it is empty). */
export const threadComments = (db: Db, threadId: string) =>
  db
    .select()
    .from(docComments)
    .where(and(eq(docComments.threadId, threadId), isNull(docComments.deletedAt)))
    .orderBy(asc(docComments.createdAt));

/** Open (unresolved) threads of a doc. */
export const openThreadCount = async (db: Db, docId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(docCommentThreads)
      .where(
        and(
          eq(docCommentThreads.docId, docId),
          isNull(docCommentThreads.deletedAt),
          isNull(docCommentThreads.resolvedAt),
        ),
      )
  )[0]?.n ?? 0;

/** Open threads per doc, for many docs at once (the sidebar). */
export const openThreadCounts = async (db: Db, docIds: string[]) =>
  new Map(
    (docIds.length
      ? await db
          .select({ docId: docCommentThreads.docId, n: sql<number>`count(*)::int` })
          .from(docCommentThreads)
          .where(
            and(
              inArray(docCommentThreads.docId, docIds),
              isNull(docCommentThreads.deletedAt),
              isNull(docCommentThreads.resolvedAt),
            ),
          )
          .groupBy(docCommentThreads.docId)
      : []
    ).map((r) => [r.docId, r.n]),
  );

/** Docs that hold this file (doc_assets), for file access through a doc. */
export const docsHoldingAsset = async (db: Db, accountId: string, assetId: string) =>
  (
    await db
      .select({ id: docAssets.docId })
      .from(docAssets)
      .where(and(eq(docAssets.accountId, accountId), eq(docAssets.assetId, assetId)))
  ).map((r) => r.id);

/** The live cell doc of an item's column, if one was made. */
export const findCellDoc = async (db: Db, itemId: string, columnId: string): Promise<DocMeta | undefined> =>
  (
    await db
      .select(meta)
      .from(docs)
      .where(and(eq(docs.itemId, itemId), eq(docs.columnId, columnId), eq(docs.host, 'cell'), live))
      .limit(1)
  )[0];

/** All the docs of one cell, oldest first (a file column's cell holds several — Fix: ). */
export const listCellDocs = (db: Db, itemId: string, columnId: string) =>
  db
    .select({ id: docs.id, name: docs.name })
    .from(docs)
    .where(and(eq(docs.itemId, itemId), eq(docs.columnId, columnId), eq(docs.host, 'cell'), live))
    .orderBy(asc(docs.createdAt), asc(docs.id));

