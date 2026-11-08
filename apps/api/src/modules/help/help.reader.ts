// SPDX-License-Identifier: AGPL-3.0-only
import {
  type HelpCenterSettings,
  AppError,
  type HelpArticleKind,
  type HelpArticleView,
  type HelpCenterInfo,
  helpAssetPath,
  isId,
  type HelpEventKind,
  type HelpHit,
  type HelpLocale,
  type HelpOptions,
  type HelpRouteKey,
  helpArticleUrl,
  newId,
  type RichNode,
} from '@bines/shared';
import type { AppDeps } from '../../types';
import { toTsQuery } from '../agents/knowledge/extract';
import { loadPlatformSettings, productName } from '../platform/platform-settings';
import { guideView, renderArticle } from './help.content';
import { findTour } from './tours.repo';
import { assistantState } from './help.ai';
import {
  articlesInCategory,
  articlesWithTags,
  bumpArticleCounter,
  categoryArticleCounts,
  findArticle,
  findArticleBySlug,
  groupArticles,
  type HelpArticleRow,
  type HelpHitRow,
  insertHelpEvent,
  listHelpCategories,
  readableArticles,
  searchArticles,
  withdrawHelpVotes,
} from './help.repo';
import { categoryDto } from './help.service';
import { helpLinkBase, loadHelpSettings } from './help.settings';
import { webOrigin } from '../platform/public-address';

/**
 * The knowledge center, the readers' side: the "?" help panel and the ticket form inside an account
 * (members — published articles of either visibility), and the public help center (no sign-in — `public` articles
 * only; a signed-in person sees the `signed_in` ones too). Searches, views and "did this help?" are recorded for
 * the metrics.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger'>;
export type HelpReader = {
  /** null = not signed in (the public help center). */
  userId: string | null;
  accountId: string | null;
  locale: HelpLocale;
  /** The AI reading for a person: AI-only articles too; no search / view counted in the metrics. */
  ai?: boolean;
};

/** The tag of the AI-only articles, hidden from this reader (none for the AI). */
const hiddenTagFor = (r: Pick<HelpReader, 'ai'>, s: HelpCenterSettings) => (r.ai ? null : s.ai_knowledge.ai_only_tag);

/** What a signed-in person (an account member) may read: published articles of either visibility. */
export const MEMBER_VISIBILITIES = ['public', 'signed_in'];
const visibilitiesOf = (r: Pick<HelpReader, 'userId'>) => (r.userId ? MEMBER_VISIBILITIES : ['public']);
export const localeOf = (raw: string | null | undefined): HelpLocale => (raw === 'en' ? 'en' : 'he');

export const excerptOf = (row: Pick<HelpHitRow, 'excerpt' | 'body'>) =>
  (row.excerpt || row.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);

const hitDto =
  (base: string, origin = '') =>
  (r: HelpHitRow): HelpHit => ({
    id: r.id,
    slug: r.slug,
    locale: r.locale as HelpLocale,
    title: r.title,
    excerpt: excerptOf(r),
    category_id: r.category_id ?? null,
    tags: r.tags ?? [],
    url: helpArticleUrl(base, r.slug, r.locale as HelpLocale),
    kind: r.kind === 'guide' ? 'guide' : 'article',
    duration: r.duration === null || r.duration === undefined ? null : Number(r.duration),
    poster: r.poster_id && isId(r.poster_id) ? `${origin.replace(/\/+$/, '')}${helpAssetPath(r.poster_id)}` : null,
    step_count: Number(r.step_count ?? 0),
  });

const record = async (
  deps: Pick<Deps, 'db'>,
  r: HelpReader,
  kind: HelpEventKind,
  extra: { articleId?: string; query?: string } = {},
) => {
  // The AI's lookups are not people's searches / views (the knowledge center's metrics stay people's).
  if (r.ai) return;
  await insertHelpEvent(deps.db, {
    id: newId(),
    kind,
    accountId: r.accountId,
    userId: r.userId,
    articleId: extra.articleId ?? null,
    query: extra.query?.slice(0, 200) ?? null,
    locale: r.locale,
  });
};

const assertEnabled = async (deps: Pick<Deps, 'db'>, r: HelpReader) => {
  const s = await loadHelpSettings(deps.db);
  if (!s.enabled || (!r.userId && !s.public_enabled)) throw new AppError('not_found', 'Help center not found');
  return s;
};

/** GET /support/help/options — what the panel and the ticket form offer this person. */
export const helpOptions = async (
  deps: Pick<Deps, 'db'>,
  r: HelpReader & { accountId: string },
): Promise<HelpOptions> => {
  const settings = await loadHelpSettings(deps.db);
  const [categories, state, counts] = await Promise.all([
    listHelpCategories(deps.db),
    assistantState(deps, r.accountId),
    // In the reader's language, like a category's list (`searchHelp` with a category and no words).
    categoryArticleCounts(deps.db, {
      visibilities: visibilitiesOf(r),
      locale: r.locale,
      hideTag: hiddenTagFor(r, settings),
    }),
  ]);
  return {
    enabled: settings.enabled,
    show_articles: settings.enabled && settings.flow.show_articles,
    max_suggestions: settings.flow.max_suggestions,
    assistant: state.available,
    assistant_off_reason: state.available ? null : state.reason,
    cap_message: settings.ai.cap_message,
    locale: r.locale,
    categories: categories.filter((c) => !c.archivedAt).map(categoryDto),
    category_counts: Object.fromEntries(counts.map((c) => [c.category_id, Number(c.count)])),
  };
};

/**
 * Search (and the suggestions while typing a ticket subject, `mode: typing`): the person's language first, then any.
 * A final search that finds nothing is recorded — the "missing articles" list.
 */
export const searchHelp = async (
  deps: Pick<Deps, 'db' | 'env'>,
  r: HelpReader,
  q: {
    q?: string;
    route?: HelpRouteKey;
    category_id?: string;
    locale?: HelpLocale;
    limit?: number;
    mode?: 'search' | 'typing';
    kind?: HelpArticleKind;
  },
) => {
  const settings = await assertEnabled(deps, r);
  const origin = await webOrigin(deps);
  const toHit = hitDto(helpLinkBase(settings, origin), r.userId ? '' : origin);
  const limit = q.limit ?? (q.mode === 'typing' ? settings.flow.max_suggestions : 10);
  const visibilities = visibilitiesOf(r);
  const hideTag = hiddenTagFor(r, settings);
  const locale = q.locale ?? r.locale;
  const text = q.q?.trim() ?? '';
  if (!text && q.kind) {
    // The "practical guides" row: the reader's language first, then any.
    let rows = await readableArticles(deps.db, { visibilities, locale, kind: q.kind, limit, hideTag });
    if (!rows.length) rows = await readableArticles(deps.db, { visibilities, kind: q.kind, limit, hideTag });
    return { data: rows.map(toHit) };
  }
  if (!text && q.category_id) {
    const rows = await articlesInCategory(deps.db, q.category_id, { visibilities, locale, limit, hideTag });
    return { data: rows.map(toHit) };
  }
  if (!text) {
    // No words: the screen's articles (the "?" panel's "articles for this page").
    const tags = q.route ? (settings.route_tags.find((x) => x.route === q.route)?.tags ?? []) : [];
    let rows = await articlesWithTags(deps.db, tags, { visibilities, locale, limit, hideTag });
    if (!rows.length && tags.length) rows = await articlesWithTags(deps.db, tags, { visibilities, limit, hideTag });
    return { data: rows.map(toHit) };
  }
  const tsquery = toTsQuery(text);
  let rows = tsquery
    ? await searchArticles(deps.db, tsquery, {
        visibilities,
        locale,
        categoryId: q.category_id,
        kind: q.kind,
        limit,
        hideTag,
      })
    : [];
  if (!rows.length && tsquery)
    rows = await searchArticles(deps.db, tsquery, {
      visibilities,
      categoryId: q.category_id,
      kind: q.kind,
      limit,
      hideTag,
    });
  if (q.mode !== 'typing') {
    await record(deps, r, 'search', { query: text });
    if (!rows.length) await record(deps, r, 'search_no_result', { query: text });
  }
  return { data: rows.map(toHit) };
};

const viewDto = async (
  deps: Pick<Deps, 'db' | 'env'>,
  a: HelpArticleRow,
  r: HelpReader,
  base: string,
): Promise<HelpArticleView> => {
  const origin = await webOrigin(deps);
  const { html } = renderArticle((a.publishedContent ?? { type: 'doc', content: [] }) as RichNode, origin);
  const visible = new Set(visibilitiesOf(r));
  // "Show me in the app": only inside the app (a signed-in reader), and only a published tour.
  const tour = a.tourId && r.userId ? await findTour(deps.db, a.tourId) : undefined;
  const guide = a.kind === 'guide' ? guideView(a.publishedGuide, r.userId ? '' : origin) : null;
  return {
    id: a.id,
    slug: a.slug,
    locale: a.locale as HelpLocale,
    title: a.publishedTitle ?? a.title,
    excerpt: excerptOf({ excerpt: a.excerpt, body: a.publishedText ?? '' }),
    category_id: a.categoryId ?? null,
    tags: a.tags ?? [],
    url: helpArticleUrl(base, a.slug, a.locale as HelpLocale),
    html,
    visibility: a.visibility as HelpArticleView['visibility'],
    published_at: a.publishedAt?.toISOString() ?? null,
    translations: (await groupArticles(deps.db, a.groupId))
      .filter((x) => x.id !== a.id && x.status === 'published' && visible.has(x.visibility))
      .map((x) => ({ slug: x.slug, locale: x.locale as HelpLocale, title: x.publishedTitle ?? x.title })),
    kind: a.kind === 'guide' ? 'guide' : 'article',
    duration: guide?.video?.duration ?? null,
    poster: guide?.video?.poster ?? null,
    step_count: guide?.steps.length ?? 0,
    guide,
    tour_id: tour?.status === 'published' ? tour.id : null,
  };
};

/** One published article by id or slug (a drafts never, a `signed_in` one only to the signed in) — a "view". */
export const viewHelpArticle = async (
  deps: Pick<Deps, 'db' | 'env'>,
  r: HelpReader,
  key: string,
  locale?: HelpLocale,
) => {
  const settings = await assertEnabled(deps, r);
  const a =
    (await findArticle(deps.db, key)) ??
    (await findArticleBySlug(deps.db, locale ?? r.locale, key)) ??
    (await findArticleBySlug(deps.db, (locale ?? r.locale) === 'he' ? 'en' : 'he', key));
  const hidden = hiddenTagFor(r, settings);
  if (
    !a ||
    a.status !== 'published' ||
    !visibilitiesOf(r).includes(a.visibility) ||
    (hidden && a.tags?.includes(hidden))
  )
    throw new AppError('not_found', 'Article not found');
  if (!r.ai) await bumpArticleCounter(deps.db, a.id, 'views');
  await record(deps, r, 'view', { articleId: a.id });
  return viewDto(deps, a, r, helpLinkBase(settings, await webOrigin(deps)));
};

/** POST /support/help/articles/{id}/feedback — "did this help?". */
export const helpFeedback = async (deps: Pick<Deps, 'db'>, r: HelpReader, id: string, helpful: boolean) => {
  const a = await findArticle(deps.db, id);
  if (!a || a.status !== 'published' || !visibilitiesOf(r).includes(a.visibility))
    throw new AppError('not_found', 'Article not found');
  // One vote per person per article (decision c): a signed-in reader's latest vote replaces the earlier one. The
  // public help center has no person to tie a vote to, so each anonymous vote counts.
  await deps.db.transaction(async (tx) => {
    const userId = r.userId;
    if (userId) await withdrawHelpVotes(tx, a.id, userId);
    await bumpArticleCounter(tx, a.id, helpful ? 'helpfulYes' : 'helpfulNo');
    await record({ db: tx }, r, helpful ? 'helpful_yes' : 'helpful_no', { articleId: a.id });
  });
  return { ok: true as const };
};

/** POST /support/help/events — the app's own: deflected (found the answer, no ticket) / ticket_opened after help. */
export const helpClientEvent = async (
  deps: Pick<Deps, 'db'>,
  r: HelpReader,
  input: { kind: 'deflected' | 'ticket_opened'; article_id?: string | null; query?: string },
) => {
  const article = input.article_id ? await findArticle(deps.db, input.article_id) : undefined;
  await record(deps, r, input.kind, { articleId: article?.id, query: input.query });
  return { ok: true as const };
};

/** GET /help/center — the public help center's brand (the platform's product name) and its categories. */
export const helpCenterInfo = async (deps: Pick<Deps, 'db'>, r: HelpReader): Promise<HelpCenterInfo> => {
  const settings = await assertEnabled(deps, r);
  const [platform, categories] = await Promise.all([loadPlatformSettings(deps.db), listHelpCategories(deps.db)]);
  return {
    enabled: settings.enabled,
    product_name: productName(platform, r.locale),
    logo_url: settings.logo_url,
    categories: categories.filter((c) => !c.archivedAt).map(categoryDto),
  };
};
