// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AddAgentKnowledge,
  addAgentKnowledgeSchema,
  type AgentKnowledge,
  AppError,
  KNOWLEDGE_LIMITS,
  newId,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { enqueueJob } from '../../lib/jobs';
import type { AppDeps, RequestMeta } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { loadDocAccess } from '../docs/docs.access';
import { ownUploadedAssets, releaseAssets } from '../files/files.service';
import type { Actor } from '../items/items.service';
import { type AgentRow, agentBoardRows, ensureWorkspaceMember, upsertAgentBoard } from './agents.repo';
import { loadManagedAgent } from './agents.service';
import { creatorActor } from './engine/context';
import { chunkText, extractFileText, knowledgeFileType, tidy, toTsQuery } from './knowledge/extract';
import {
  deleteChunks,
  findKnowledge,
  findKnowledgeById,
  insertKnowledge,
  type KnowledgeRow,
  listKnowledgeRows,
  liveAsset,
  liveBoard,
  liveDoc,
  replaceChunks,
  searchChunks,
  updateKnowledge,
} from './knowledge.repo';

/**
 * An agent's knowledge base (the planning notes "AGENTS-MCP" מ9, D26): files (text extracted on the server), docs, notes
 * and boards. Text sources are cut into passages and searched with Postgres full-text search (decision: FTS, no
 * embeddings). Boards are not indexed — the agent reads them with its board tools, through the same permissions
 * as everything else. Nothing here gives an agent more than its creator can read: a doc counts only while the
 * creator can still read it, a board only while they can see it, a deleted file leaves the index.
 */
type Deps = AppDeps;

const iso = (d: Date | null) => d?.toISOString() ?? null;

const dto = (r: KnowledgeRow): AgentKnowledge => ({
  id: r.id,
  kind: r.kind as AgentKnowledge['kind'],
  title: r.title,
  status: r.status as AgentKnowledge['status'],
  error: r.error,
  chunks: r.chunks,
  chars: r.chars,
  file_id: r.assetId,
  doc_id: r.docId,
  board_id: r.boardId,
  truncated: r.truncated,
  created_at: r.createdAt.toISOString(),
  indexed_at: iso(r.indexedAt),
});

export const listKnowledge = async (deps: Deps, a: Actor, agentId: string) => {
  const found = await loadManagedAgent(deps.db, a, agentId);
  return { data: (await listKnowledgeRows(deps.db, a.ctx.accountId, found.a.id)).map(dto) };
};

const audit = (db: Db, a: Actor, meta: RequestMeta | null, action: string, agent: AgentRow, row: KnowledgeRow) =>
  recordAudit(db, {
    accountId: agent.accountId,
    actorId: a.user.id,
    action,
    targetType: 'agent',
    targetId: agent.id,
    payload: { source_id: row.id, kind: row.kind, title: row.title },
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
  });

/** Indexes now or in a job (`agent.knowledge_index`); without the queue (tests) it runs right here. */
const queueIndex = async (deps: Deps, sourceId: string) => {
  if (!(await enqueueJob(deps.db, 'agent.knowledge_index', { source_id: sourceId }, { maxAttempts: 2 })))
    await indexSource(deps, sourceId);
};

/**
 * POST /agents/:id/knowledge — adds a source. Who adds it must be able to read it (my own upload, a doc / board I
 * can read), and so must the agent's creator (the agent never knows more than its creator). A board also becomes
 * one the agent may read (view) when it was not one of its boards.
 */
export const addKnowledge = async (
  deps: Deps,
  a: Actor,
  agentId: string,
  raw: AddAgentKnowledge,
  meta: RequestMeta,
) => {
  const found = await loadManagedAgent(deps.db, a, agentId);
  const agent = found.a;
  const input = addAgentKnowledgeSchema.parse(raw);
  const existing = await listKnowledgeRows(deps.db, a.ctx.accountId, agent.id);
  if (existing.length >= KNOWLEDGE_LIMITS.sources) throw new AppError('conflict', 'knowledge_sources_limit');
  const creator = await creatorActor(deps.db, agent);
  const base = { id: newId(), accountId: agent.accountId, agentId: agent.id, addedBy: a.user.id };
  let row: KnowledgeRow;
  const insert = async (v: Parameters<typeof insertKnowledge>[1]) => (await insertKnowledge(deps.db, v))[0]!;
  switch (input.kind) {
    case 'file': {
      const [asset] = await ownUploadedAssets(deps.db, a, [input.file_id]);
      if (!knowledgeFileType(asset!.fileName)) throw new AppError('invalid_value', 'knowledge_file_type');
      if (asset!.size > KNOWLEDGE_LIMITS.fileBytes) throw new AppError('payload_too_large', 'knowledge_file_too_large');
      if (existing.some((x) => x.assetId === asset!.id)) throw new AppError('conflict', 'knowledge_source_exists');
      row = await insert({ ...base, kind: 'file', title: asset!.fileName, assetId: asset!.id });
      break;
    }
    case 'doc': {
      const access = await loadDocAccess(deps.db, a.ctx, a.user, input.doc_id);
      await loadDocAccess(deps.db, creator.ctx, creator.user, input.doc_id).catch(() => {
        throw new AppError('forbidden', 'knowledge_creator_cannot_read');
      });
      if (existing.some((x) => x.docId === access.doc.id)) throw new AppError('conflict', 'knowledge_source_exists');
      row = await insert({ ...base, kind: 'doc', title: access.doc.name, docId: access.doc.id });
      break;
    }
    case 'board': {
      const access = await loadBoardAccess(deps.db, a.ctx, a.user, input.board_id);
      if (access.board.parentBoardId) throw new AppError('invalid_value', 'subitems_board');
      await loadBoardAccess(deps.db, creator.ctx, creator.user, input.board_id).catch(() => {
        throw new AppError('forbidden', 'knowledge_creator_cannot_read');
      });
      if (existing.some((x) => x.boardId === access.board.id))
        throw new AppError('conflict', 'knowledge_source_exists');
      // The agent reads the board with its tools: it must be one of its boards (view, unless it already edits it).
      const boards = await agentBoardRows(deps.db, agent.accountId, agent.userId);
      if (!boards.some((b) => b.boardId === access.board.id)) {
        await upsertAgentBoard(deps.db, {
          accountId: agent.accountId,
          boardId: access.board.id,
          userId: agent.userId,
          level: 'viewer',
          addedBy: a.user.id,
        });
        if (access.workspace.kind === 'closed')
          await ensureWorkspaceMember(deps.db, {
            id: newId(),
            accountId: agent.accountId,
            workspaceId: access.workspace.id,
            userId: agent.userId,
            addedBy: a.user.id,
          });
      }
      row = await insert({
        ...base,
        kind: 'board',
        title: access.board.name,
        boardId: access.board.id,
        status: 'ready',
        indexedAt: new Date(),
      });
      break;
    }
    case 'note':
      row = await insert({ ...base, kind: 'note', title: input.title, body: input.text });
      break;
  }
  await audit(deps.db, a, meta, 'agent.knowledge_added', agent, row!);
  if (row!.kind !== 'board') await queueIndex(deps, row!.id);
  return dto((await findKnowledge(deps.db, a.ctx.accountId, row!.id))!);
};

const loadSource = async (deps: Deps, a: Actor, agentId: string, sourceId: string) => {
  const found = await loadManagedAgent(deps.db, a, agentId);
  const row = await findKnowledge(deps.db, a.ctx.accountId, sourceId);
  if (!row || row.agentId !== found.a.id) throw new AppError('not_found', 'Knowledge source not found');
  return { agent: found.a, row };
};

/** DELETE /agents/:id/knowledge/:sourceId — out of the index at once; an uploaded file leaves storage too. */
export const removeKnowledge = async (deps: Deps, a: Actor, agentId: string, sourceId: string, meta: RequestMeta) => {
  const { agent, row } = await loadSource(deps, a, agentId, sourceId);
  await deps.db.transaction(async (tx) => {
    await updateKnowledge(tx, row.id, { deletedAt: new Date() });
    await deleteChunks(tx, row.id);
    await audit(tx, a, meta, 'agent.knowledge_removed', agent, row);
  });
  if (row.assetId) await releaseAssets(deps, row.accountId, [row.assetId]);
  return { ok: true as const };
};

/** POST /agents/:id/knowledge/:sourceId/reindex — reads the source again (a doc that changed, a failed file). */
export const reindexKnowledge = async (deps: Deps, a: Actor, agentId: string, sourceId: string) => {
  const { row } = await loadSource(deps, a, agentId, sourceId);
  if (row.kind === 'board') return dto(row);
  await updateKnowledge(deps.db, row.id, { status: 'indexing', error: null });
  await queueIndex(deps, row.id);
  return dto((await findKnowledge(deps.db, a.ctx.accountId, row.id))!);
};

/** The text of a source, before tidying (null + error code when it cannot be read). */
const sourceText = async (deps: Deps, row: KnowledgeRow): Promise<{ text: string } | { error: string }> => {
  switch (row.kind) {
    case 'note':
      return { text: row.body ?? '' };
    case 'doc': {
      const doc = row.docId ? await liveDoc(deps.db, row.accountId, row.docId) : undefined;
      if (!doc) return { error: 'knowledge_source_gone' };
      return { text: `${doc.name}\n\n${doc.textValue}` };
    }
    case 'file': {
      const asset = row.assetId ? await liveAsset(deps.db, row.accountId, row.assetId) : undefined;
      if (!asset?.storageKey) return { error: 'knowledge_source_gone' };
      const type = knowledgeFileType(asset.fileName);
      if (!type) return { error: 'knowledge_file_type' };
      if (asset.size > KNOWLEDGE_LIMITS.fileBytes) return { error: 'knowledge_file_too_large' };
      const buf = await deps.storage.get(asset.storageKey, KNOWLEDGE_LIMITS.fileBytes);
      if (!buf) return { error: 'knowledge_file_missing' };
      try {
        return { text: await extractFileText(type, buf) };
      } catch (err) {
        return { error: err instanceof AppError ? err.message : 'knowledge_unreadable_file' };
      }
    }
    default:
      return { error: 'knowledge_not_indexed' };
  }
};

/** `agent.knowledge_index`: text → tidy → cap → passages → `knowledge_chunks` (tsvector generated by Postgres). */
export const indexSource = async (deps: Deps, sourceId: string) => {
  const row = await findKnowledgeById(deps.db, sourceId);
  if (!row || row.deletedAt || row.kind === 'board') return null;
  const got = await sourceText(deps, row);
  if ('error' in got) {
    await deleteChunks(deps.db, row.id);
    return (await updateKnowledge(deps.db, row.id, { status: 'error', error: got.error, chunks: 0, chars: 0 }))[0];
  }
  const full = tidy(got.text);
  const truncated = full.length > KNOWLEDGE_LIMITS.textChars;
  const text = truncated ? full.slice(0, KNOWLEDGE_LIMITS.textChars) : full;
  if (!text) {
    await deleteChunks(deps.db, row.id);
    return (
      await updateKnowledge(deps.db, row.id, { status: 'error', error: 'knowledge_empty', chunks: 0, chars: 0 })
    )[0];
  }
  const chunks = chunkText(text);
  await deps.db.transaction(async (tx) => {
    await replaceChunks(tx, row, chunks, newId);
    await updateKnowledge(tx, row.id, {
      status: 'ready',
      error: null,
      chunks: chunks.length,
      chars: text.length,
      truncated,
      indexedAt: new Date(),
    });
  });
  return (await findKnowledge(deps.db, row.accountId, row.id))!;
};

/** The sources the agent may use right now: indexed, still there, and readable by its creator. */
const usableSources = async (db: Db, agent: AgentRow) => {
  const rows = (await listKnowledgeRows(db, agent.accountId, agent.id)).filter((r) => r.status === 'ready');
  if (!rows.length) return { text: [] as KnowledgeRow[], boards: [] as KnowledgeRow[] };
  let creator: Actor | null = null;
  try {
    creator = await creatorActor(db, agent);
  } catch {
    creator = null;
  }
  const text: KnowledgeRow[] = [];
  const boards: KnowledgeRow[] = [];
  const readableBoards = creator
    ? await readableBoardIds(
        db,
        creator.ctx,
        creator.user,
        rows.flatMap((r) => (r.boardId ? [r.boardId] : [])),
      )
    : new Set<string>();
  for (const r of rows) {
    if (r.kind === 'note') text.push(r);
    else if (r.kind === 'file') {
      if (r.assetId && (await liveAsset(db, agent.accountId, r.assetId))) text.push(r);
    } else if (r.kind === 'doc') {
      if (!creator || !r.docId) continue;
      const ok = await loadDocAccess(db, creator.ctx, creator.user, r.docId).then(
        () => true,
        () => false,
      );
      if (ok) text.push(r);
    } else if (r.kind === 'board') {
      if (r.boardId && readableBoards.has(r.boardId) && (await liveBoard(db, agent.accountId, r.boardId)))
        boards.push(r);
    }
  }
  return { text, boards };
};

/** Does the agent have anything to search? (decides whether `search_knowledge` is offered to the model) */
export const hasKnowledge = async (db: Db, agent: AgentRow) =>
  (await listKnowledgeRows(db, agent.accountId, agent.id)).some((r) => r.status === 'ready');

/** The `search_knowledge` tool: best passages (with their source) + the board sources to read with the tools. */
export const searchKnowledgeFor = async (db: Db, agent: AgentRow, input: { query: string; limit?: number }) => {
  const { text, boards } = await usableSources(db, agent);
  const tsquery = toTsQuery(input.query);
  const limit = Math.min(Math.max(input.limit ?? KNOWLEDGE_LIMITS.searchResults, 1), 20);
  const byId = new Map(text.map((r) => [r.id, r]));
  const hits = tsquery
    ? await searchChunks(
        db,
        agent.accountId,
        agent.id,
        text.map((r) => r.id),
        tsquery,
        limit,
      )
    : [];
  return {
    results: hits.map((h) => {
      const src = byId.get(h.sourceId)!;
      return { source: src.id, kind: src.kind, title: src.title, passage: h.ord + 1, text: h.body };
    }),
    boards: boards.map((b) => ({ board_id: b.boardId!, name: b.title })),
    ...(hits.length ? {} : { note: 'Nothing matched — try other keywords, or read the boards with the board tools.' }),
  };
};
