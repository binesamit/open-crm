// SPDX-License-Identifier: AGPL-3.0-only
import {
  AI_PROVIDER_INFO,
  AppError,
  type CreateHelpArticle,
  createHelpArticleSchema,
  type HelpArticleDetail,
  type HelpArticleSummary,
  type HelpCategory,
  type HelpConsoleConfig,
  type HelpGuide,
  type HelpMetrics,
  helpSlugOf,
  newId,
  type RichNode,
  TICKET_DONE_STATUSES,
  type TicketStatus,
  type UpdateHelpArticle,
  type UpdateHelpCenterSettings,
  updateHelpArticleSchema,
  updateHelpCenterSettingsSchema,
  upsertHelpCategorySchema,
} from '@bines/shared';
import type { z } from 'zod';
import { keyHint } from '../../lib/secrets';
import type { AppDeps } from '../../types';
import { findAccountById } from '../accounts/accounts.repo';
import { chunkText, tidy } from '../agents/knowledge/extract';
import { assertAiBaseUrl } from '../ai/ai-fetch';
import { forgetModels, localAiAllowedFor } from '../ai/models.service';
import type { StaffActor } from '../tickets/console.service';
import { findTicket, insertEvent, listMessages } from '../tickets/tickets.repo';
import { canonical, cleanGuide, cleanHelpContent, guideText, renderArticle, scrubPii, textToDoc } from './help.content';
import { findTour } from './tours.repo';
import {
  articleEventStats,
  deleteArticleChunks,
  eventCounts,
  findArticle,
  findHelpCategory,
  findVersion,
  groupArticles,
  type HelpArticleRow,
  type HelpCategoryRow,
  insertArticle,
  insertHelpCategory,
  insertVersion,
  listArticleRows,
  listHelpCategories,
  listVersions,
  replaceArticleChunks,
  slugTaken,
  updateArticleRow,
  updateHelpCategory,
  usedTags,
  zeroResultQueries,
} from './help.repo';
import { helpSettingsDto, loadHelpSettings, storeHelpSettings } from './help.settings';

/**
 * The knowledge center, the staff side: owner console → Support → Knowledge. Who may: the platform
 * owner (everything); support staff by the settings — `write_roles` write and save drafts, `publish_roles` publish;
 * categories and settings are the leads' (like the helpdesk settings). Articles are platform data, never an account's.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'secrets'>;

export const mayWrite = (s: StaffActor, settings: { write_roles: string[] }) =>
  s.role === 'owner' || settings.write_roles.includes(s.role);
export const mayPublish = (s: StaffActor, settings: { publish_roles: string[] }) =>
  s.role === 'owner' || settings.publish_roles.includes(s.role);
const mayConfigure = (s: StaffActor) => s.role !== 'agent';

const assertWrite = async (deps: Pick<Deps, 'db'>, s: StaffActor) => {
  if (!mayWrite(s, await loadHelpSettings(deps.db))) throw new AppError('forbidden', 'help_write_forbidden');
};
const assertPublish = async (deps: Pick<Deps, 'db'>, s: StaffActor) => {
  if (!mayPublish(s, await loadHelpSettings(deps.db))) throw new AppError('forbidden', 'help_publish_forbidden');
};
export const assertConfigure = (s: StaffActor) => {
  if (!mayConfigure(s)) throw new AppError('forbidden', 'support_lead_only');
};

export const categoryDto = (c: HelpCategoryRow): HelpCategory => ({
  id: c.id,
  name: c.name,
  name_en: c.nameEn ?? null,
  icon: c.icon ?? null,
  position: c.position,
  archived: !!c.archivedAt,
});

export const articleSummary = (a: HelpArticleRow): HelpArticleSummary => ({
  id: a.id,
  group_id: a.groupId,
  locale: a.locale as HelpArticleSummary['locale'],
  slug: a.slug,
  title: a.title,
  excerpt: a.excerpt,
  category_id: a.categoryId ?? null,
  tags: a.tags ?? [],
  visibility: a.visibility as HelpArticleSummary['visibility'],
  status: a.status as HelpArticleSummary['status'],
  unpublished_changes: a.status === 'published' && (a.publishedVersion ?? 0) < a.version,
  version: a.version,
  published_version: a.publishedVersion ?? null,
  published_at: a.publishedAt?.toISOString() ?? null,
  updated_at: a.updatedAt.toISOString(),
  helpful_yes: a.helpfulYes,
  helpful_no: a.helpfulNo,
  views: a.views,
  source_ticket_id: a.sourceTicketId ?? null,
  kind: a.kind === 'guide' ? 'guide' : 'article',
  tour_id: a.tourId ?? null,
});

const articleDetail = async (deps: Pick<Deps, 'db'>, a: HelpArticleRow): Promise<HelpArticleDetail> => ({
  ...articleSummary(a),
  content: a.content as RichNode,
  guide: (a.guide as HelpGuide | null) ?? null,
  translations: (await groupArticles(deps.db, a.groupId))
    .filter((x) => x.id !== a.id)
    .map((x) => ({ id: x.id, locale: x.locale as HelpArticleSummary['locale'], title: x.title })),
});

const mustArticle = async (deps: Pick<Deps, 'db'>, id: string) => {
  const a = await findArticle(deps.db, id);
  if (!a) throw new AppError('not_found', 'Article not found');
  return a;
};

const assertCategory = async (deps: Pick<Deps, 'db'>, id: string | null | undefined) => {
  if (!id) return;
  const c = await findHelpCategory(deps.db, id);
  if (!c || c.archivedAt) throw new AppError('invalid_value', 'help_category_unknown');
};

/** "Show me in the app": the tour must exist (a draft is fine — readers get it once published). */
const assertTour = async (deps: Pick<Deps, 'db'>, id: string | null | undefined) => {
  if (!id) return;
  if (!(await findTour(deps.db, id))) throw new AppError('invalid_value', 'help_tour_unknown');
};

/** Same guide (stored jsonb loses key order: compare canonically). */
const sameGuide = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** A free slug in the language: the title's, then -2, -3 … */
const freeSlug = async (deps: Pick<Deps, 'db'>, locale: string, base: string) => {
  for (let i = 1; i < 500; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 110)}-${i}`;
    if (!(await slugTaken(deps.db, locale, slug))) return slug;
  }
  return `${base.slice(0, 90)}-${newId().toLowerCase()}`;
};

// ---- config & settings ----

/** GET /platform/support/help/config */
export const helpConsoleConfig = async (deps: Pick<Deps, 'db'>, s: StaffActor): Promise<HelpConsoleConfig> => {
  const [settings, categories, tags] = await Promise.all([
    loadHelpSettings(deps.db),
    listHelpCategories(deps.db),
    usedTags(deps.db),
  ]);
  return {
    role: s.role,
    may_write: mayWrite(s, settings),
    may_publish: mayPublish(s, settings),
    may_configure: mayConfigure(s),
    settings: helpSettingsDto(settings),
    categories: categories.map(categoryDto),
    tags,
  };
};

/** PATCH /platform/support/help/settings — leads and the owner; the AI key is write-only (sealed). */
export const updateHelpSettings = async (deps: Deps, s: StaffActor, raw: UpdateHelpCenterSettings) => {
  assertConfigure(s);
  const patch = updateHelpCenterSettingsSchema.parse(raw);
  const current = await loadHelpSettings(deps.db);
  const { api_key, ...aiPatch } = patch.ai ?? {};
  const ai = { ...current.ai, ...aiPatch };
  if (aiPatch.provider !== undefined && aiPatch.provider !== current.ai.provider && api_key === undefined) {
    // Another provider: the old key cannot be used with it.
    ai.key_enc = null;
    ai.key_hint = null;
  }
  if (api_key !== undefined) {
    ai.key_enc = api_key ? deps.secrets.seal(api_key) : null;
    ai.key_hint = api_key ? keyHint(api_key) : null;
  }
  if (ai.key_enc && !ai.connection_id) ai.connection_id = newId();
  const info = ai.provider ? AI_PROVIDER_INFO[ai.provider] : null;
  if (info && !info.baseUrl) ai.base_url = null;
  if (aiPatch.base_url && info?.baseUrl)
    await assertAiBaseUrl(aiPatch.base_url, await localAiAllowedFor(deps.db, aiPatch.base_url));
  if (ai.enabled && (!ai.provider || (info?.keyRequired && !ai.key_enc) || (info?.baseUrl && !ai.base_url)))
    throw new AppError('invalid_value', 'help_ai_incomplete');
  const next = await storeHelpSettings(deps.db, s.user.id, {
    ...current,
    ...patch,
    flow: { ...current.flow, ...patch.flow },
    first_steps: { ...current.first_steps, ...patch.first_steps },
    ai_knowledge: { ...current.ai_knowledge, ...patch.ai_knowledge },
    ai,
  });
  if (ai.connection_id && (api_key !== undefined || aiPatch.base_url !== undefined)) forgetModels(ai.connection_id);
  deps.logger.info({ by: s.user.id, fields: Object.keys(patch) }, 'help center settings updated');
  return helpSettingsDto(next);
};

// ---- categories ----

export const saveHelpCategory = async (
  deps: Pick<Deps, 'db'>,
  s: StaffActor,
  id: string | null,
  raw: z.input<typeof upsertHelpCategorySchema>,
) => {
  assertConfigure(s);
  const input = upsertHelpCategorySchema.parse(raw);
  if (id) {
    if (!(await findHelpCategory(deps.db, id))) throw new AppError('not_found', 'Category not found');
    await updateHelpCategory(deps.db, id, {
      name: input.name,
      ...(input.name_en !== undefined ? { nameEn: input.name_en || null } : {}),
      ...(input.icon !== undefined ? { icon: input.icon || null } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
    });
  } else {
    const count = (await listHelpCategories(deps.db)).length;
    await insertHelpCategory(deps.db, {
      id: newId(),
      name: input.name,
      nameEn: input.name_en || null,
      icon: input.icon || null,
      position: input.position ?? count,
    });
  }
  return { categories: (await listHelpCategories(deps.db)).map(categoryDto) };
};

// ---- articles ----

export const listHelpArticles = async (
  deps: Pick<Deps, 'db'>,
  _s: StaffActor,
  f: { q?: string; status?: string; locale?: string; category_id?: string; kind?: string },
) => ({
  data: (await listArticleRows(deps.db, { ...f, categoryId: f.category_id })).map(articleSummary),
});

export const getHelpArticle = async (deps: Pick<Deps, 'db'>, _s: StaffActor, id: string) =>
  articleDetail(deps, await mustArticle(deps, id));

/** POST /platform/support/help/articles — a draft (version 1); a translation joins the original's group. */
export const createHelpArticle = async (
  deps: Pick<Deps, 'db'>,
  s: StaffActor,
  raw: CreateHelpArticle,
  extra: { sourceTicketId?: string } = {},
) => {
  await assertWrite(deps, s);
  const input = createHelpArticleSchema.parse(raw);
  await assertCategory(deps, input.category_id);
  let groupId: string | null = null;
  if (input.translation_of) {
    const original = await mustArticle(deps, input.translation_of);
    const group = await groupArticles(deps.db, original.groupId);
    if (group.some((g) => g.locale === input.locale)) throw new AppError('conflict', 'help_translation_exists');
    groupId = original.groupId;
  }
  const slug = input.slug
    ? input.slug.toLowerCase()
    : await freeSlug(deps, input.locale, helpSlugOf(input.title).toLowerCase());
  if (input.slug && (await slugTaken(deps.db, input.locale, slug))) throw new AppError('slug_taken', 'help_slug_taken');
  const content = await cleanHelpContent(deps.db, input.content);
  await assertTour(deps, input.tour_id);
  const guide = await cleanGuide(deps.db, input.guide ?? (input.kind === 'guide' ? {} : null));
  const id = newId();
  const row = await deps.db.transaction(async (tx) => {
    const created = await insertArticle(tx, {
      id,
      groupId: groupId ?? id,
      locale: input.locale,
      slug,
      title: input.title,
      excerpt: input.excerpt ?? '',
      categoryId: input.category_id ?? null,
      tags: [...new Set(input.tags ?? [])],
      visibility: input.visibility,
      status: 'draft',
      content: content as Record<string, unknown>,
      kind: input.kind,
      guide: guide as Record<string, unknown> | null,
      tourId: input.tour_id ?? null,
      version: 1,
      sourceTicketId: extra.sourceTicketId ?? null,
      createdBy: s.user.id,
      updatedBy: s.user.id,
    });
    await insertVersion(tx, {
      id: newId(),
      articleId: id,
      version: 1,
      kind: 'save',
      title: input.title,
      content: content as Record<string, unknown>,
      guide: guide as Record<string, unknown> | null,
      createdBy: s.user.id,
    });
    return created;
  });
  return articleDetail(deps, row);
};

/** PATCH — the working copy; a new title / content is a new version (the published one stays until "publish"). */
export const updateHelpArticle = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string, raw: UpdateHelpArticle) => {
  await assertWrite(deps, s);
  const input = updateHelpArticleSchema.parse(raw);
  const a = await mustArticle(deps, id);
  if (input.category_id !== undefined) await assertCategory(deps, input.category_id);
  const slug = input.slug?.toLowerCase();
  if (slug && slug !== a.slug && (await slugTaken(deps.db, a.locale, slug, a.id)))
    throw new AppError('slug_taken', 'help_slug_taken');
  const content = input.content ? await cleanHelpContent(deps.db, input.content) : undefined;
  if (input.tour_id !== undefined) await assertTour(deps, input.tour_id);
  // A guide's video and steps: turning an article into a guide starts an empty one.
  const guide =
    input.guide !== undefined
      ? await cleanGuide(deps.db, input.guide ?? (input.kind === 'guide' || a.kind === 'guide' ? {} : null))
      : input.kind === 'guide' && !a.guide
        ? await cleanGuide(deps.db, {})
        : undefined;
  const changed =
    (input.title !== undefined && input.title !== a.title) ||
    (content !== undefined && JSON.stringify(content) !== JSON.stringify(a.content)) ||
    (guide !== undefined && !sameGuide(guide, a.guide));
  const row = await deps.db.transaction(async (tx) => {
    const version = changed ? a.version + 1 : a.version;
    const next = await updateArticleRow(tx, a.id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(slug ? { slug } : {}),
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      ...(input.category_id !== undefined ? { categoryId: input.category_id } : {}),
      ...(input.tags ? { tags: [...new Set(input.tags)] } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(content ? { content: content as Record<string, unknown> } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(guide !== undefined ? { guide: guide as Record<string, unknown> | null } : {}),
      ...(input.tour_id !== undefined ? { tourId: input.tour_id } : {}),
      version,
      updatedBy: s.user.id,
    });
    if (changed)
      await insertVersion(tx, {
        id: newId(),
        articleId: a.id,
        version,
        kind: 'save',
        title: next.title,
        content: next.content,
        guide: next.guide ?? null,
        createdBy: s.user.id,
      });
    // The tags / title of the published passages follow at once only for metadata; content waits for "publish".
    return next;
  });
  return articleDetail(deps, row);
};

/** Indexes the published version: passages of its text (title on every passage, weighted). */
const indexPublished = async (db: Deps['db'], a: HelpArticleRow) => {
  if (a.status !== 'published' || !a.publishedTitle) return deleteArticleChunks(db, a.id);
  return replaceArticleChunks(db, a.id, a.publishedTitle, chunkText(tidy(a.publishedText ?? '')), newId);
};

/** POST …/publish — the working copy becomes what readers see (and what search and the assistant use). */
export const publishHelpArticle = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string) => {
  await assertPublish(deps, s);
  const a = await mustArticle(deps, id);
  const { text } = renderArticle(a.content as RichNode);
  // A guide's steps are searched with the article (and read by the help assistant).
  const steps = a.kind === 'guide' ? guideText(a.guide) : '';
  const row = await deps.db.transaction(async (tx) => {
    const next = await updateArticleRow(tx, a.id, {
      status: 'published',
      publishedTitle: a.title,
      publishedContent: a.content,
      publishedGuide: a.kind === 'guide' ? (a.guide ?? null) : null,
      publishedText: [steps, text].filter((x) => x.trim()).join('\n\n'),
      publishedVersion: a.version,
      publishedAt: new Date(),
      publishedBy: s.user.id,
    });
    await insertVersion(tx, {
      id: newId(),
      articleId: a.id,
      version: a.version,
      kind: 'publish',
      title: a.title,
      content: a.content,
      guide: a.guide ?? null,
      createdBy: s.user.id,
    });
    await indexPublished(tx, next);
    return next;
  });
  return articleDetail(deps, row);
};

/** POST …/unpublish — back to a draft: out of search, the help panel and the assistant. */
export const unpublishHelpArticle = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string) => {
  await assertPublish(deps, s);
  const a = await mustArticle(deps, id);
  const row = await deps.db.transaction(async (tx) => {
    const next = await updateArticleRow(tx, a.id, {
      status: 'draft',
      publishedTitle: null,
      publishedContent: null,
      publishedGuide: null,
      publishedText: null,
      publishedVersion: null,
    });
    await deleteArticleChunks(tx, a.id);
    return next;
  });
  return articleDetail(deps, row);
};

/** DELETE — soft; a published article is taken down first (publishers only). */
export const deleteHelpArticle = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string) => {
  const a = await mustArticle(deps, id);
  if (a.status === 'published') await assertPublish(deps, s);
  else await assertWrite(deps, s);
  await deps.db.transaction(async (tx) => {
    await updateArticleRow(tx, a.id, { deletedAt: new Date(), status: 'draft' });
    await deleteArticleChunks(tx, a.id);
  });
  return { ok: true as const };
};

export const listHelpVersions = async (deps: Pick<Deps, 'db'>, _s: StaffActor, id: string) => {
  const a = await mustArticle(deps, id);
  return {
    data: (await listVersions(deps.db, a.id)).map((r) => ({
      id: r.v.id,
      version: r.v.version,
      kind: r.v.kind as 'save' | 'publish' | 'restore',
      title: r.v.title,
      created_at: r.v.createdAt.toISOString(),
      created_by_name: r.by ?? null,
    })),
  };
};

/** POST …/versions/{versionId}/restore — the old title and content as a new version of the working copy. */
export const restoreHelpVersion = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string, versionId: string) => {
  await assertWrite(deps, s);
  const a = await mustArticle(deps, id);
  const v = await findVersion(deps.db, a.id, versionId);
  if (!v) throw new AppError('not_found', 'Version not found');
  const row = await deps.db.transaction(async (tx) => {
    const version = a.version + 1;
    // A version saved before guides existed has no guide: the article's current one stays.
    const guide = v.guide ?? a.guide ?? null;
    const next = await updateArticleRow(tx, a.id, {
      title: v.title,
      content: v.content,
      guide,
      version,
      updatedBy: s.user.id,
    });
    await insertVersion(tx, {
      id: newId(),
      articleId: a.id,
      version,
      kind: 'restore',
      title: v.title,
      content: v.content,
      guide,
      createdBy: s.user.id,
    });
    return next;
  });
  return articleDetail(deps, row);
};

// ---- ticket → article ----

/**
 * POST /platform/support/tickets/{id}/article — a draft from a solved / closed ticket: its subject, the customer's
 * question and the public staff answers, with personal details taken out. Never published by itself.
 */
export const articleFromTicket = async (deps: Pick<Deps, 'db'>, s: StaffActor, ticketId: string) => {
  await assertWrite(deps, s);
  const t = await findTicket(deps.db, ticketId);
  if (!t) throw new AppError('not_found', 'Ticket not found');
  if (!TICKET_DONE_STATUSES.includes(t.status as TicketStatus))
    throw new AppError('conflict', 'help_ticket_not_solved');
  const [messages, account] = await Promise.all([
    listMessages(deps.db, t.id, true),
    findAccountById(deps.db, t.accountId),
  ]);
  const known = {
    names: [t.requesterName, ...messages.map((m) => m.authorName)].filter(Boolean),
    account: [account?.name, account?.slug].filter((x): x is string => !!x),
  };
  const scrub = (text: string) => scrubPii(scrubPii(text, known).replace(t.requesterEmail, '[email]'), known);
  const question = messages.filter((m) => m.kind === 'customer').slice(0, 1);
  const answers = messages.filter((m) => m.kind === 'staff');
  const content = textToDoc([question.map((m) => scrub(m.body)), answers.map((m) => scrub(m.body))]);
  const title = scrub(t.subject).slice(0, 200) || helpSlugOf(String(t.number));
  const article = await createHelpArticle(
    deps,
    s,
    { title, locale: s.user.locale === 'en' ? 'en' : 'he', visibility: 'signed_in', content },
    { sourceTicketId: t.id },
  );
  await insertEvent(deps.db, t.id, s.user.id, 'article_drafted', { article_id: article.id });
  return article;
};

// ---- metrics ----

/** GET /platform/support/help/metrics?days= */
export const helpMetrics = async (deps: Pick<Deps, 'db'>, _s: StaffActor, days: number): Promise<HelpMetrics> => {
  const since = new Date(Date.now() - days * 86_400_000);
  const [counts, zero, articles] = await Promise.all([
    eventCounts(deps.db, since),
    zeroResultQueries(deps.db, since),
    articleEventStats(deps.db, since),
  ]);
  const n = (k: Parameters<typeof counts.get>[0]) => counts.get(k) ?? 0;
  const deflected = n('deflected');
  const opened = n('ticket_opened');
  return {
    days,
    searches: n('search'),
    zero_result_searches: n('search_no_result'),
    views: n('view'),
    helpful_yes: n('helpful_yes'),
    helpful_no: n('helpful_no'),
    deflected,
    tickets_opened: opened,
    deflection_rate: deflected + opened ? Math.round((deflected / (deflected + opened)) * 1000) / 1000 : null,
    ai_answers: n('ai_answer'),
    ai_not_found: n('ai_not_found'),
    zero_result_queries: zero.map((r) => ({ query: r.query, count: Number(r.count) })),
    articles: articles.map((r) => ({
      id: r.id,
      title: r.title,
      locale: r.locale,
      views: Number(r.views),
      helpful_yes: Number(r.helpful_yes),
      helpful_no: Number(r.helpful_no),
    })),
  };
};
