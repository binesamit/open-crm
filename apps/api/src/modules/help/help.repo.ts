// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gte, ilike, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { HelpEventKind } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  aiUsage,
  helpArticles,
  helpArticleVersions,
  helpCategories,
  helpChunks,
  helpEvents,
  users,
} from '../../db/schema';

/** The knowledge center's tables — platform level, no account scope (articles belong to no account). */
export type HelpArticleRow = typeof helpArticles.$inferSelect;
export type HelpCategoryRow = typeof helpCategories.$inferSelect;

const live = isNull(helpArticles.deletedAt);

/** Raw reads (search ranking, arrays): the driver's result rows, typed by the caller. */
const exec = async <T>(db: Db, q: SQL) => (await db.execute(q)) as unknown as { rows: T[] };

// ---- categories ----

export const listHelpCategories = (db: Db) =>
  db.select().from(helpCategories).orderBy(asc(helpCategories.position), asc(helpCategories.name));

export const findHelpCategory = async (db: Db, id: string) =>
  (await db.select().from(helpCategories).where(eq(helpCategories.id, id)).limit(1))[0];

export const insertHelpCategory = async (db: Db, row: typeof helpCategories.$inferInsert) =>
  (await db.insert(helpCategories).values(row).returning())[0]!;

export const updateHelpCategory = (db: Db, id: string, patch: Partial<typeof helpCategories.$inferInsert>) =>
  db
    .update(helpCategories)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(helpCategories.id, id));

// ---- articles ----

export const findArticle = async (db: Db, id: string) =>
  (
    await db
      .select()
      .from(helpArticles)
      .where(and(eq(helpArticles.id, id), live))
      .limit(1)
  )[0];

export const findArticleBySlug = async (db: Db, locale: string, slug: string) =>
  (
    await db
      .select()
      .from(helpArticles)
      .where(and(eq(helpArticles.locale, locale), eq(helpArticles.slug, slug), live))
      .limit(1)
  )[0];

export const slugTaken = async (db: Db, locale: string, slug: string, exceptId?: string) =>
  (
    await db
      .select({ id: helpArticles.id })
      .from(helpArticles)
      .where(
        and(
          eq(helpArticles.locale, locale),
          eq(helpArticles.slug, slug),
          live,
          ...(exceptId ? [ne(helpArticles.id, exceptId)] : []),
        ),
      )
      .limit(1)
  ).length > 0;

export const groupArticles = (db: Db, groupId: string) =>
  db
    .select()
    .from(helpArticles)
    .where(and(eq(helpArticles.groupId, groupId), live));

export const insertArticle = async (db: Db, row: typeof helpArticles.$inferInsert) =>
  (await db.insert(helpArticles).values(row).returning())[0]!;

export const updateArticleRow = async (db: Db, id: string, patch: Partial<typeof helpArticles.$inferInsert>) =>
  (
    await db
      .update(helpArticles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(helpArticles.id, id))
      .returning()
  )[0]!;

export const bumpArticleCounter = (db: Db, id: string, field: 'views' | 'helpfulYes' | 'helpfulNo') =>
  db
    .update(helpArticles)
    .set({ [field]: sql`${helpArticles[field]} + 1` })
    .where(eq(helpArticles.id, id));

export const listArticleRows = (
  db: Db,
  f: { q?: string; status?: string; locale?: string; categoryId?: string; kind?: string; limit?: number },
) =>
  db
    .select()
    .from(helpArticles)
    .where(
      and(
        live,
        ...(f.q ? [ilike(helpArticles.title, `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)] : []),
        ...(f.status ? [eq(helpArticles.status, f.status)] : []),
        ...(f.locale ? [eq(helpArticles.locale, f.locale)] : []),
        ...(f.categoryId ? [eq(helpArticles.categoryId, f.categoryId)] : []),
        ...(f.kind ? [eq(helpArticles.kind, f.kind)] : []),
      ),
    )
    .orderBy(desc(helpArticles.updatedAt))
    .limit(f.limit ?? 500);

export const usedTags = async (db: Db) =>
  (
    await exec<{ tag: string }>(
      db,
      sql`select distinct unnest(tags) as tag from help_articles where deleted_at is null order by 1 limit 500`,
    )
  ).rows.map((r) => r.tag);

// ---- versions ----

export const insertVersion = (db: Db, row: typeof helpArticleVersions.$inferInsert) =>
  db.insert(helpArticleVersions).values(row);

export const listVersions = (db: Db, articleId: string) =>
  db
    .select({ v: helpArticleVersions, by: users.name })
    .from(helpArticleVersions)
    .leftJoin(users, eq(users.id, helpArticleVersions.createdBy))
    .where(eq(helpArticleVersions.articleId, articleId))
    .orderBy(desc(helpArticleVersions.createdAt), desc(helpArticleVersions.version))
    .limit(200);

export const findVersion = async (db: Db, articleId: string, id: string) =>
  (
    await db
      .select()
      .from(helpArticleVersions)
      .where(and(eq(helpArticleVersions.articleId, articleId), eq(helpArticleVersions.id, id)))
      .limit(1)
  )[0];

// ---- passages (search) ----

export const replaceArticleChunks = async (
  db: Db,
  articleId: string,
  title: string,
  bodies: string[],
  newId: () => string,
) => {
  await db.delete(helpChunks).where(eq(helpChunks.articleId, articleId));
  const rows = (bodies.length ? bodies : ['']).map((body, ord) => ({ id: newId(), articleId, ord, title, body }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(helpChunks).values(rows.slice(i, i + 500));
};

export const deleteArticleChunks = (db: Db, articleId: string) =>
  db.delete(helpChunks).where(eq(helpChunks.articleId, articleId));

/** What a hit carries of a guide: its kind, video length, still and number of steps (the cards). */
const GUIDE_COLS = sql`a.kind, (a.published_guide->'video'->>'duration')::int as duration,
  a.published_guide->'video'->>'poster_id' as poster_id,
  coalesce(jsonb_array_length(a.published_guide->'steps'), 0) as step_count`;

/** Which published articles a reader may see: visibility + (optionally) language, category and kind. */
const readable = (f: {
  visibilities: string[];
  locale?: string | null;
  categoryId?: string | null;
  kind?: string | null;
  /** Articles carrying this tag are for the AI only: hidden from people. */
  hideTag?: string | null;
}): SQL => {
  const parts: SQL[] = [
    sql`a.status = 'published'`,
    sql`a.deleted_at is null`,
    sql`a.visibility in (${sql.join(
      f.visibilities.map((v) => sql`${v}`),
      sql`, `,
    )})`,
  ];
  if (f.locale) parts.push(sql`a.locale = ${f.locale}`);
  if (f.categoryId) parts.push(sql`a.category_id = ${f.categoryId}`);
  if (f.kind) parts.push(sql`a.kind = ${f.kind}`);
  if (f.hideTag) parts.push(sql`not (coalesce(a.tags, '{}') @> array[${f.hideTag}]::text[])`);
  return sql.join(parts, sql` and `);
};

export type HelpHitRow = {
  id: string;
  slug: string;
  locale: string;
  title: string;
  excerpt: string;
  category_id: string | null;
  tags: string[];
  kind: string;
  duration: number | null;
  poster_id: string | null;
  step_count: number | string;
  body: string;
  rank: number;
};

/**
 * Full-text search over the published passages (`tsquery` built like the agents' knowledge search: terms OR-ed,
 * prefix matches, Hebrew one-letter prefixes stripped). One row per article — its best passage — best first.
 */
export const searchArticles = async (
  db: Db,
  tsquery: string,
  f: {
    visibilities: string[];
    locale?: string | null;
    categoryId?: string | null;
    kind?: string | null;
    limit: number;
    hideTag?: string | null;
  },
) =>
  (
    await exec<HelpHitRow>(
      db,
      sql`
      select a.id, a.slug, a.locale, a.published_title as title, a.excerpt, a.category_id, a.tags, ${GUIDE_COLS}, best.body, best.rank
      from (
        select distinct on (ch.article_id) ch.article_id, ch.body,
               ts_rank_cd(ch.tsv, to_tsquery('simple', ${tsquery})) as rank
        from help_chunks ch
        where ch.tsv @@ to_tsquery('simple', ${tsquery})
        order by ch.article_id, rank desc, ch.ord
      ) best
      join help_articles a on a.id = best.article_id
      where ${readable(f)}
      order by best.rank desc, a.helpful_yes desc
      limit ${f.limit}`,
    )
  ).rows;

/** The passages the help assistant reads: the best ones over all readable articles (several per article allowed). */
export const searchPassages = async (
  db: Db,
  tsquery: string,
  f: { visibilities: string[]; locale?: string | null; limit: number },
) =>
  (
    await exec<{ id: string; slug: string; locale: string; title: string; body: string; rank: number }>(
      db,
      sql`
      select a.id, a.slug, a.locale, a.published_title as title, ch.body,
             ts_rank_cd(ch.tsv, to_tsquery('simple', ${tsquery})) as rank
      from help_chunks ch
      join help_articles a on a.id = ch.article_id
      where ch.tsv @@ to_tsquery('simple', ${tsquery}) and ${readable(f)}
      order by rank desc, ch.ord
      limit ${f.limit}`,
    )
  ).rows;

/** Published articles carrying any of the tags (the "?" panel's suggestions for a screen), most helpful first. */
export const articlesWithTags = async (
  db: Db,
  tags: string[],
  f: { visibilities: string[]; locale?: string | null; limit: number; hideTag?: string | null },
) =>
  tags.length
    ? (
        await exec<HelpHitRow>(
          db,
          sql`
          select a.id, a.slug, a.locale, a.published_title as title, a.excerpt, a.category_id, a.tags, ${GUIDE_COLS},
                 coalesce(a.published_text, '') as body, 0 as rank
          from help_articles a
          where ${readable(f)} and a.tags && ${sql`array[${sql.join(
            tags.map((t) => sql`${t}`),
            sql`, `,
          )}]::text[]`}
          order by (a.helpful_yes - a.helpful_no) desc, a.views desc, a.published_at desc
          limit ${f.limit}`,
        )
      ).rows
    : [];

/** Published articles of a category (the public help center's category page), most helpful first. */
export const articlesInCategory = async (
  db: Db,
  categoryId: string,
  f: { visibilities: string[]; locale?: string | null; limit: number; hideTag?: string | null },
) =>
  (
    await exec<HelpHitRow>(
      db,
      sql`
      select a.id, a.slug, a.locale, a.published_title as title, a.excerpt, a.category_id, a.tags, ${GUIDE_COLS},
             coalesce(a.published_text, '') as body, 0 as rank
      from help_articles a
      where ${readable({ ...f, categoryId })}
      order by (a.helpful_yes - a.helpful_no) desc, a.views desc, a.published_title
      limit ${f.limit}`,
    )
  ).rows;

/**
 * Published articles a reader may see, newest published first; `q` narrows to titles holding the words (the support
 * console's "attach an article" picker, when full-text search finds nothing or there are no words yet).
 */
export const readableArticles = async (
  db: Db,
  f: {
    visibilities: string[];
    locale?: string | null;
    q?: string;
    kind?: string | null;
    limit: number;
    hideTag?: string | null;
  },
) =>
  (
    await exec<HelpHitRow>(
      db,
      sql`
      select a.id, a.slug, a.locale, a.published_title as title, a.excerpt, a.category_id, a.tags, ${GUIDE_COLS},
             coalesce(a.published_text, '') as body, 0 as rank
      from help_articles a
      where ${readable(f)}${
        f.q?.trim() ? sql` and a.published_title ilike ${`%${f.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`}` : sql``
      }
      order by a.published_at desc nulls last, a.published_title
      limit ${f.limit}`,
    )
  ).rows;

/** How many published articles a reader may see in each category (the knowledge center page's category cards). */
export const categoryArticleCounts = async (
  db: Db,
  f: { visibilities: string[]; locale?: string | null; hideTag?: string | null },
) =>
  (
    await exec<{ category_id: string; count: number | string }>(
      db,
      sql`
      select a.category_id, count(*) as count
      from help_articles a
      where ${readable(f)} and a.category_id is not null
      group by a.category_id`,
    )
  ).rows;

// ---- events & metrics ----

export const insertHelpEvent = (db: Db, row: typeof helpEvents.$inferInsert) => db.insert(helpEvents).values(row);

/**
 * "Did this help?" counts one vote per person per article (decision c): removes the person's earlier votes on the
 * article and takes them off its counters, so the caller records only the latest. Returns how many were removed.
 */
export const withdrawHelpVotes = async (db: Db, articleId: string, userId: string) => {
  const gone = await db
    .delete(helpEvents)
    .where(
      and(
        eq(helpEvents.articleId, articleId),
        eq(helpEvents.userId, userId),
        inArray(helpEvents.kind, ['helpful_yes', 'helpful_no']),
      ),
    )
    .returning({ kind: helpEvents.kind });
  const yes = gone.filter((g) => g.kind === 'helpful_yes').length;
  const no = gone.length - yes;
  if (gone.length)
    await db
      .update(helpArticles)
      .set({
        helpfulYes: sql`greatest(${helpArticles.helpfulYes} - ${yes}, 0)`,
        helpfulNo: sql`greatest(${helpArticles.helpfulNo} - ${no}, 0)`,
      })
      .where(eq(helpArticles.id, articleId));
  return gone.length;
};

export const eventCounts = async (db: Db, since: Date) => {
  const rows = await db
    .select({ kind: helpEvents.kind, n: sql<number>`count(*)::int` })
    .from(helpEvents)
    .where(gte(helpEvents.createdAt, since))
    .groupBy(helpEvents.kind);
  return new Map(rows.map((r) => [r.kind as HelpEventKind, Number(r.n)]));
};

export const zeroResultQueries = async (db: Db, since: Date) =>
  (
    await exec<{ query: string; count: number }>(
      db,
      sql`
      select lower(trim(query)) as query, count(*)::int as count
      from help_events
      where kind = 'search_no_result' and created_at >= ${since} and query is not null and trim(query) <> ''
      group by 1 order by 2 desc, 1 limit 50`,
    )
  ).rows;

export const articleEventStats = async (db: Db, since: Date) =>
  (
    await exec<{
      id: string;
      title: string;
      locale: string;
      views: number;
      helpful_yes: number;
      helpful_no: number;
    }>(
      db,
      sql`
      select a.id, a.title, a.locale,
             count(*) filter (where e.kind = 'view')::int as views,
             count(*) filter (where e.kind = 'helpful_yes')::int as helpful_yes,
             count(*) filter (where e.kind = 'helpful_no')::int as helpful_no
      from help_events e join help_articles a on a.id = e.article_id
      where e.created_at >= ${since} and e.kind in ('view', 'helpful_yes', 'helpful_no')
      group by a.id, a.title, a.locale
      order by 4 desc, 5 desc limit 100`,
    )
  ).rows;

/** USD the platform's help connection spent for an account in [from, to). */
export const helpSpend = async (db: Db, accountId: string, connectionId: string, from: string, to: string) => {
  const [row] = await db
    .select({ cost: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)` })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.accountId, accountId),
        eq(aiUsage.source, 'help'),
        eq(aiUsage.connectionId, connectionId),
        gte(aiUsage.day, from),
        sql`${aiUsage.day} < ${to}`,
      ),
    );
  return Number(row?.cost ?? 0);
};

export const articlesByIds = (db: Db, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(helpArticles)
        .where(and(inArray(helpArticles.id, ids), live))
    : Promise.resolve([] as HelpArticleRow[]);
