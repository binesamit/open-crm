// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { answer, defineTool, id } from './types';

/**
 * Product knowledge for AI: the help center — articles, practical guides and guided tours the
 * platform owner writes and edits — as tools, in the reader's language and as they may read it. Nothing about the
 * product is written into the tools or the prompts: what the help center says is what the AI knows.
 */

const hit = answer({
  id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  kind: z.enum(['article', 'guide']),
  url: z.string(),
});

export const searchHelp = defineTool({
  name: 'search_help',
  title: 'Search the help center',
  description:
    'Searches the product\'s help center (articles and step-by-step guides) for how something works or how to do it — "how do I add a column", "what is a mirror column", "how do automations work". Use it before answering any how-to question about the product, then answer from what it found (get_help_article for the full text) with the article\'s link. Words in the user\'s language work best.',
  family: 'help',
  scope: 'any',
  risk: 'read',
  input: z.object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  output: answer({ data: z.array(hit) }),
});

export const getHelpArticle = defineTool({
  name: 'get_help_article',
  title: 'Read a help article',
  description:
    'One help-center article or guide in full (by the id or slug search_help gave): its text, a guide\'s numbered steps, its link, and the id of its guided tour ("show me") when it has one.',
  family: 'help',
  scope: 'any',
  risk: 'read',
  input: z.object({ article: z.string().trim().min(1).max(200).describe('Article id or slug (from search_help)') }),
  output: answer({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    url: z.string(),
    steps: z.array(z.string()),
    tour_id: z.string().nullable(),
  }),
});

export const showMe = defineTool({
  name: 'show_me',
  title: 'Show me in the app',
  description:
    'Offers the person a guided tour of the app (a "show me" button in the chat that runs it on their screen): the tour_id get_help_article gave. Elsewhere (an agent, an AI app) it returns the tour\'s steps as text to walk the person through.',
  family: 'help',
  scope: 'any',
  risk: 'read',
  input: z.object({ tour_id: id('Tour') }),
  output: answer({ tour_id: z.string(), title: z.string(), steps: z.array(z.string()) }),
});
