// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, helpArticleUrl, type HelpLocale, type TicketArticle, type TicketArticleList } from '@bines/shared';
import type { AppDeps } from '../../types';
import { toTsQuery } from '../agents/knowledge/extract';
import { webOrigin } from '../platform/public-address';
import {
  articlesByIds,
  type HelpArticleRow,
  type HelpHitRow,
  readableArticles,
  searchArticles,
} from '../help/help.repo';
import { excerptOf, MEMBER_VISIBILITIES } from '../help/help.reader';
import { helpLinkBase, loadHelpSettings } from '../help/help.settings';

/**
 * Knowledge-center articles on a ticket: support attaches an article to a reply when it sees fit, and
 * the customer sees it as a card. A reply keeps only the articles' ids, so a card always shows the article as it is
 * now; what may be attached, and what a card shows, are the readers' rules for the ticket's customer (an account
 * member): the help center is on, the article is published and not deleted, its visibility is one a member reads.
 */
type Deps = Pick<AppDeps, 'db' | 'env'>;

const readable = (a: HelpArticleRow) =>
  !a.deletedAt && a.status === 'published' && MEMBER_VISIBILITIES.includes(a.visibility);

/** The base of article links, or null while the help center is off (nothing is attachable or shown then). */
const linkBase = async (deps: Deps) => {
  const settings = await loadHelpSettings(deps.db);
  return settings.enabled ? helpLinkBase(settings, await webOrigin(deps)) : null;
};

const fromRow = (base: string, a: HelpArticleRow): TicketArticle => ({
  id: a.id,
  slug: a.slug,
  locale: a.locale,
  title: a.publishedTitle ?? a.title,
  excerpt: excerptOf({ excerpt: a.excerpt, body: a.publishedText ?? '' }),
  url: helpArticleUrl(base, a.slug, a.locale as HelpLocale),
});

const fromHit = (base: string, h: HelpHitRow): TicketArticle => ({
  id: h.id,
  slug: h.slug,
  locale: h.locale,
  title: h.title,
  excerpt: excerptOf(h),
  url: helpArticleUrl(base, h.slug, h.locale as HelpLocale),
});

/** The cards of these ids that the customer may read now (an unpublished or deleted article drops out). */
export const ticketArticlesByIds = async (deps: Deps, ids: string[]): Promise<Map<string, TicketArticle>> => {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const base = await linkBase(deps);
  if (!base) return new Map();
  const rows = await articlesByIds(deps.db, unique);
  return new Map(rows.filter(readable).map((a) => [a.id, fromRow(base, a)]));
};

/** The articles a reply asks to attach, in its order — each must be one the customer may read. */
export const attachableArticles = async (deps: Deps, ids: string[]): Promise<TicketArticle[]> => {
  const unique = [...new Set(ids)];
  const found = await ticketArticlesByIds(deps, unique);
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) throw new AppError('invalid_value', 'ticket_article_unavailable', { article_ids: missing });
  return unique.map((id) => found.get(id)!);
};

/**
 * GET /platform/support/tickets/{id}/articles?q= — the picker: full-text search over what the customer may read (the
 * same search as the help panel), else titles holding the words; no words = the latest published.
 */
export const searchAttachableArticles = async (
  deps: Deps,
  f: { q?: string; limit?: number },
): Promise<TicketArticleList> => {
  const base = await linkBase(deps);
  if (!base) return { enabled: false, data: [] };
  const limit = f.limit ?? 20;
  const text = f.q?.trim() ?? '';
  const visibilities = MEMBER_VISIBILITIES;
  // AI-only articles are not for customers.
  const hideTag = (await loadHelpSettings(deps.db)).ai_knowledge.ai_only_tag;
  const tsquery = text ? toTsQuery(text) : '';
  let rows = tsquery ? await searchArticles(deps.db, tsquery, { visibilities, limit, hideTag }) : [];
  if (!rows.length) rows = await readableArticles(deps.db, { visibilities, q: text, limit, hideTag });
  return { enabled: true, data: rows.map((h) => fromHit(base, h)) };
};
