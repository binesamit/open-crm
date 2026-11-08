// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { wrapUntrusted } from '../agents/engine/prompt';
import { likePattern } from '../search/search.repo';
import { excerptAround } from '../search/search.service';
import { assertDoc, loadDocAccess, readableDocs } from './docs.access';
import { docTextHits, loadDocContent } from './docs.repo';

/**
 * Reading docs with the AI (`get_doc`, `search_docs` of shared/ai/tools/docs.ts) for the assistant, agents and the
 * MCP server — through the docs module's own access path, like GET /docs/:id/content and the search page: a doc the
 * actor may not read is a 404, and a token limited to some boards sees no docs. A doc's text is written by people,
 * so it reaches a model only wrapped as untrusted content.
 */

/** The most of a doc's text one `get_doc` returns (≈ 30k characters; the rest is cut, `truncated`). */
export const DOC_TOOL_TEXT_MAX = 30_000;
/** A search hit's text around the match, ellipses included. */
const SNIPPET = 300;
/** Candidates fetched per result wanted: some of them may be docs the actor cannot read. */
const SURPLUS = 5;

const untrusted = (docId: string, text: string) => wrapUntrusted(`doc:${docId}`, text);

export const toolGetDoc = async (db: Db, a: Actor, docId: string) => {
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.read');
  const { doc } = access;
  const row = (await loadDocContent(db, a.ctx.accountId, doc.id))!;
  const text = row.text ?? '';
  const truncated = text.length > DOC_TOOL_TEXT_MAX;
  return {
    id: doc.id,
    title: doc.name,
    workspace_id: doc.workspaceId,
    updated_at: (row.updatedAt ?? doc.updatedAt).toISOString(),
    text: untrusted(doc.id, truncated ? text.slice(0, DOC_TOOL_TEXT_MAX) : text),
    truncated,
  };
};

export const toolSearchDocs = async (db: Db, a: Actor, query: string, limit: number) => {
  const q = query.trim();
  const hits = await docTextHits(db, a.ctx.accountId, q, likePattern(q), limit * SURPLUS);
  const readable = await readableDocs(db, a.ctx, a.user, hits);
  return {
    docs: readable.slice(0, limit).map(({ doc }) => {
      const around = (hits.find((h) => h.id === doc.id)?.around ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: doc.id,
        title: doc.name,
        snippet: around ? untrusted(doc.id, excerptAround(around, q, SNIPPET - 2)) : '',
        updated_at: doc.updatedAt.toISOString(),
      };
    }),
  };
};
