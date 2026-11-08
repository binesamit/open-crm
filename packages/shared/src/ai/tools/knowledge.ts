// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { answer, defineTool } from './types';

/**
 * `search_knowledge` (the planning notes "AGENTS-MCP" מ9): an agent-only tool — not in AI_TOOLS (the MCP server and the
 * agent tool picker list those). The agent loop adds it on its own when the agent has knowledge, and runs it in
 * apps/api/src/modules/agents/knowledge.service.ts: full-text search (Postgres FTS, `simple` config — Hebrew
 * without stemming) over the agent's files, docs and notes, filtered to what its creator can still read; board
 * sources are named so the agent reads them with its board tools.
 */
export const SEARCH_KNOWLEDGE = 'search_knowledge';

export const searchKnowledge = defineTool({
  name: SEARCH_KNOWLEDGE,
  title: 'Search the knowledge base',
  description:
    "Searches this agent's knowledge base (uploaded files, docs and notes its admin added) and returns the best matching passages with their source title — quote the source when you use one. Use short keyword queries in the language of the content; try another wording if nothing matches. Boards in the knowledge base are listed under `boards`: read them with get_board / query_items.",
  family: 'search',
  scope: 'any',
  risk: 'read',
  input: z.object({
    query: z.string().trim().min(1).max(300).describe('Keywords to look for'),
    limit: z.number().int().min(1).max(20).default(8).describe('Max passages (1–20)'),
  }),
  output: answer({
    results: z.array(answer({ source: z.string(), title: z.string(), text: z.string() })),
    boards: z.array(answer({ board_id: z.string(), name: z.string() })),
  }),
});
