// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { agentKnowledge, assets, boards, docs, knowledgeChunks } from '../../db/schema';

/** An agent's knowledge base (מ9). Every query filters by account (CLAUDE.md rule 7). */
export type KnowledgeRow = typeof agentKnowledge.$inferSelect;

export const listKnowledgeRows = (db: Db, accountId: string, agentId: string) =>
  db
    .select()
    .from(agentKnowledge)
    .where(
      and(
        eq(agentKnowledge.accountId, accountId),
        eq(agentKnowledge.agentId, agentId),
        isNull(agentKnowledge.deletedAt),
      ),
    )
    .orderBy(asc(agentKnowledge.createdAt));

export const findKnowledge = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(agentKnowledge)
      .where(and(eq(agentKnowledge.accountId, accountId), eq(agentKnowledge.id, id), isNull(agentKnowledge.deletedAt)))
      .limit(1)
  )[0];

/** By id alone — the indexing job (its payload is the source id; the row carries its account). */
export const findKnowledgeById = async (db: Db, id: string) =>
  (await db.select().from(agentKnowledge).where(eq(agentKnowledge.id, id)).limit(1))[0];

export const insertKnowledge = (db: Db, row: typeof agentKnowledge.$inferInsert) =>
  db.insert(agentKnowledge).values(row).returning();

export const updateKnowledge = (db: Db, id: string, patch: Partial<typeof agentKnowledge.$inferInsert>) =>
  db.update(agentKnowledge).set(patch).where(eq(agentKnowledge.id, id)).returning();

/** Sources per agent: all of them and the indexed ones (the agents list shows both). */
export const knowledgeCounts = async (db: Db, accountId: string) => {
  const rows = await db
    .select({ agentId: agentKnowledge.agentId, status: agentKnowledge.status, n: count() })
    .from(agentKnowledge)
    .where(and(eq(agentKnowledge.accountId, accountId), isNull(agentKnowledge.deletedAt)))
    .groupBy(agentKnowledge.agentId, agentKnowledge.status);
  const out = new Map<string, { sources: number; ready: number }>();
  for (const r of rows) {
    const cur = out.get(r.agentId) ?? { sources: 0, ready: 0 };
    cur.sources += Number(r.n);
    if (r.status === 'ready') cur.ready += Number(r.n);
    out.set(r.agentId, cur);
  }
  return out;
};

/** Replaces the passages of a source (re-indexing writes them anew). */
export const replaceChunks = async (
  db: Db,
  source: Pick<KnowledgeRow, 'id' | 'accountId' | 'agentId'>,
  bodies: string[],
  newId: () => string,
) => {
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, source.id));
  const rows = bodies.map((body, ord) => ({
    id: newId(),
    accountId: source.accountId,
    agentId: source.agentId,
    sourceId: source.id,
    ord,
    body,
  }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(knowledgeChunks).values(rows.slice(i, i + 500));
};

export const deleteChunks = (db: Db, sourceId: string) =>
  db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));

/**
 * Full-text search over an agent's passages, only in the given sources: `query` is a tsquery built by the caller
 * (terms OR-ed, prefix matches). Best first by rank.
 */
export const searchChunks = (
  db: Db,
  accountId: string,
  agentId: string,
  sourceIds: string[],
  tsquery: string,
  limit: number,
) =>
  sourceIds.length
    ? db
        .select({
          sourceId: knowledgeChunks.sourceId,
          ord: knowledgeChunks.ord,
          body: knowledgeChunks.body,
          rank: sql<number>`ts_rank_cd(${knowledgeChunks.tsv}, to_tsquery('simple', ${tsquery}))`,
        })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.accountId, accountId),
            eq(knowledgeChunks.agentId, agentId),
            inArray(knowledgeChunks.sourceId, sourceIds),
            sql`${knowledgeChunks.tsv} @@ to_tsquery('simple', ${tsquery})`,
          ),
        )
        .orderBy(sql`4 desc`, asc(knowledgeChunks.ord))
        .limit(limit)
    : Promise.resolve([]);

/** The asset of a file source (null once it was deleted). */
export const liveAsset = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(assets)
      .where(and(eq(assets.accountId, accountId), eq(assets.id, id), isNull(assets.deletedAt)))
      .limit(1)
  )[0];

export const liveDoc = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(docs)
      .where(and(eq(docs.accountId, accountId), eq(docs.id, id), isNull(docs.deletedAt)))
      .limit(1)
  )[0];

export const liveBoard = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, accountId), eq(boards.id, id), isNull(boards.deletedAt)))
      .limit(1)
  )[0];
