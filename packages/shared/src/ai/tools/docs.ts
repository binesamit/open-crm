// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { answer, defineTool, id } from './types';

/**
 * Docs (M8): reading the account's rich documents — only those the user may open (the docs module's own access
 * path). The text is the doc's plain text (what search indexes), wrapped as untrusted content: it is data written
 * by people, never instructions.
 */

export const getDoc = defineTool({
  name: 'get_doc',
  title: 'Read a doc',
  description:
    "One doc's title and plain text (headings, paragraphs, lists, tables as text; at most ~30,000 characters — `truncated` says the rest was cut). Find doc ids with search_docs or search.",
  family: 'docs',
  // Reading a doc over the REST API needs boards:read (docs are permissioned like boards).
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ doc_id: id('Doc') }),
  output: answer({
    id: z.string(),
    title: z.string(),
    workspace_id: z.string().nullable().optional(),
    updated_at: z.string(),
    text: z.string(),
    truncated: z.boolean(),
  }),
});

export const searchDocs = defineTool({
  name: 'search_docs',
  title: 'Search docs',
  description:
    'Searches the docs the user can open by title and text: id, title, a snippet around the match and when it was last edited — read one with get_doc.',
  family: 'docs',
  scope: 'search',
  risk: 'read',
  input: z.object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(10).describe('Max docs to return (1–25)'),
  }),
  output: answer({
    docs: z.array(answer({ id: z.string(), title: z.string(), snippet: z.string(), updated_at: z.string() })),
  }),
});
