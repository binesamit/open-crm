// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, helpArticleUrl, helpGuideSchema } from '@bines/shared';
import type { AppDeps } from '../../types';
import type { Actor } from '../items/items.service';
import { getAccountSettings } from '../accounts/accounts.repo';
import { webOrigin } from '../platform/public-address';
import { articlesInCategory, findArticle, findArticleBySlug } from './help.repo';
import { type HelpReader, localeOf, MEMBER_VISIBILITIES, searchHelp } from './help.reader';
import { helpLinkBase, loadHelpSettings } from './help.settings';
import { findTour } from './tours.repo';

/**
 * Product knowledge for AI: the help center as the AI's tools — search, read an article, offer a
 * guided tour. The AI reads as the person (their language; what they may read) plus the owner's AI-only articles;
 * its lookups are not counted in the knowledge center's metrics.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger'>;

const readerOf = (a: Actor): HelpReader => ({
  userId: a.user.id,
  accountId: a.ctx.accountId,
  locale: localeOf(a.user.locale),
  ai: true,
});

const MAX_TEXT = 12_000;

export const searchHelpForAi = async (deps: Deps, a: Actor, query: string, limit: number) => {
  const { data } = await searchHelp(deps, readerOf(a), { q: query, limit });
  return {
    data: data.map((h) => ({ id: h.id, slug: h.slug, title: h.title, excerpt: h.excerpt, kind: h.kind, url: h.url })),
  };
};

/** One published article (id or slug, the reader's language first) in plain text, with its guide's steps and tour. */
export const helpArticleForAi = async (deps: Deps, a: Actor, key: string) => {
  const settings = await loadHelpSettings(deps.db);
  if (!settings.enabled) throw new AppError('not_found', 'Help center not found');
  const r = readerOf(a);
  const row =
    (await findArticle(deps.db, key)) ??
    (await findArticleBySlug(deps.db, r.locale, key)) ??
    (await findArticleBySlug(deps.db, r.locale === 'he' ? 'en' : 'he', key));
  if (!row || row.status !== 'published' || row.deletedAt) throw new AppError('not_found', 'Article not found');
  const guide = row.kind === 'guide' ? helpGuideSchema.safeParse(row.publishedGuide ?? {}) : null;
  const tour = row.tourId ? await findTour(deps.db, row.tourId) : undefined;
  const text = (row.publishedText ?? '').trim();
  return {
    id: row.id,
    slug: row.slug,
    title: row.publishedTitle ?? row.title,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    url: helpArticleUrl(helpLinkBase(settings, await webOrigin(deps)), row.slug, row.locale as 'he' | 'en'),
    steps: guide?.success ? guide.data.steps.map((s) => s.text) : [],
    tour_id: tour && tour.status === 'published' ? tour.id : null,
  };
};

/** A published tour the person may take here (tours on in the account; admins' tours for admins). */
export const tourForAi = async (deps: Pick<Deps, 'db'>, a: Actor, id: string) => {
  const tour = await findTour(deps.db, id);
  const account = (await getAccountSettings(deps.db, a.ctx.accountId)) as { tours?: { enabled?: unknown } };
  const help = await loadHelpSettings(deps.db);
  if (
    !tour ||
    tour.status !== 'published' ||
    !help.enabled ||
    account.tours?.enabled === false ||
    a.ctx.role === 'guest' ||
    (tour.audience === 'admins' && a.ctx.role !== 'admin')
  )
    throw new AppError('not_found', 'Tour not found');
  const steps = (Array.isArray(tour.steps) ? tour.steps : []) as { title?: string; body?: string }[];
  return {
    tour_id: tour.id,
    title: tour.title,
    steps: steps.map((s) => [s.title, s.body].filter(Boolean).join(' — ')),
  };
};

const MAX_GUIDE = 60_000;

/**
 * The guide an AI app gets on connecting (MCP resource `bines://guide`): the published articles of
 * the owner's chosen help category (Knowledge → Settings → "guide for AI apps"), in the person's language first —
 * the owner's words, never the code's.
 */
export const aiGuideText = async (deps: Pick<Deps, 'db'>, a: Actor) => {
  const settings = await loadHelpSettings(deps.db);
  const category = settings.ai_knowledge.guide_category_id;
  if (!settings.enabled || !category)
    return 'No guide is set for AI apps. For how-to questions about the product, use search_help and get_help_article.';
  const locale = localeOf(a.user.locale);
  let rows = await articlesInCategory(deps.db, category, { visibilities: MEMBER_VISIBILITIES, locale, limit: 50 });
  if (!rows.length)
    rows = await articlesInCategory(deps.db, category, { visibilities: MEMBER_VISIBILITIES, limit: 50 });
  const text = rows.map((r) => `# ${r.title}\n\n${(r.body ?? '').trim()}`).join('\n\n');
  return text.length > MAX_GUIDE
    ? `${text.slice(0, MAX_GUIDE)}…`
    : text || 'The guide category has no published articles yet.';
};
