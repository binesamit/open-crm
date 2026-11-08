// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { helpArticles, helpTourProgress, helpTours, userProfileSettings } from '../../db/schema';

/** Guided tours — platform content (no account), and each person's progress through them. */
export type TourRow = typeof helpTours.$inferSelect;

const live = isNull(helpTours.deletedAt);

export const findTour = async (db: Db, id: string) =>
  (
    await db
      .select()
      .from(helpTours)
      .where(and(eq(helpTours.id, id), live))
      .limit(1)
  )[0];

export const findTourBySlug = async (db: Db, locale: string, slug: string) =>
  (
    await db
      .select()
      .from(helpTours)
      .where(and(eq(helpTours.locale, locale), eq(helpTours.slug, slug), live))
      .limit(1)
  )[0];

export const tourSlugTaken = async (db: Db, locale: string, slug: string, exceptId?: string) =>
  (
    await db
      .select({ id: helpTours.id })
      .from(helpTours)
      .where(
        and(
          eq(helpTours.locale, locale),
          eq(helpTours.slug, slug),
          live,
          ...(exceptId ? [ne(helpTours.id, exceptId)] : []),
        ),
      )
      .limit(1)
  ).length > 0;

export const listTourRows = (db: Db, f: { locale?: string; status?: string } = {}) =>
  db
    .select()
    .from(helpTours)
    .where(
      and(
        live,
        ...(f.locale ? [eq(helpTours.locale, f.locale)] : []),
        ...(f.status ? [eq(helpTours.status, f.status)] : []),
      ),
    )
    .orderBy(asc(helpTours.position), asc(helpTours.title))
    .limit(500);

export const insertTour = async (db: Db, row: typeof helpTours.$inferInsert) =>
  (await db.insert(helpTours).values(row).returning())[0]!;

export const updateTourRow = async (db: Db, id: string, patch: Partial<typeof helpTours.$inferInsert>) =>
  (
    await db
      .update(helpTours)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(helpTours.id, id))
      .returning()
  )[0]!;

/** tour id → what this person did with it. */
export const progressOf = async (db: Db, userId: string) =>
  new Map(
    (
      await db
        .select({ tourId: helpTourProgress.tourId, state: helpTourProgress.state })
        .from(helpTourProgress)
        .where(eq(helpTourProgress.userId, userId))
    ).map((r) => [r.tourId, r.state] as const),
  );

export const setProgress = (db: Db, userId: string, tourId: string, state: string) =>
  db
    .insert(helpTourProgress)
    .values({ userId, tourId, state })
    .onConflictDoUpdate({
      target: [helpTourProgress.userId, helpTourProgress.tourId],
      set: { state, updatedAt: new Date() },
    });

export const clearProgress = (db: Db, userId: string, tourId?: string) =>
  db
    .delete(helpTourProgress)
    .where(and(eq(helpTourProgress.userId, userId), ...(tourId ? [eq(helpTourProgress.tourId, tourId)] : [])));

/** tour id → the slug of a published guide that links it (its "watch the video"), in the reader's language first. */
export const guideSlugsOf = async (db: Db, tourIds: string[], locale: string) => {
  if (!tourIds.length) return new Map<string, string>();
  const rows = await db
    .select({ tourId: helpArticles.tourId, slug: helpArticles.slug, locale: helpArticles.locale })
    .from(helpArticles)
    .where(
      and(
        inArray(helpArticles.tourId, tourIds),
        eq(helpArticles.status, 'published'),
        eq(helpArticles.kind, 'guide'),
        isNull(helpArticles.deletedAt),
      ),
    );
  const out = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => Number(b.locale === locale) - Number(a.locale === locale)))
    if (r.tourId && !out.has(r.tourId)) out.set(r.tourId, r.slug);
  return out;
};

/** The person's own tour preference (`user_profile_settings.settings.tours`): offers on a first visit on / off. */
export const tourPrefsOf = async (db: Db, userId: string) => {
  const row = (
    await db
      .select({ tours: sql<unknown>`${userProfileSettings.settings}->'tours'` })
      .from(userProfileSettings)
      .where(eq(userProfileSettings.userId, userId))
      .limit(1)
  )[0];
  const prefs = (row?.tours ?? null) as { offers?: unknown } | null;
  return { offers: prefs?.offers !== false };
};

export const setTourPrefs = async (db: Db, userId: string, prefs: { offers: boolean }) => {
  const json = JSON.stringify(prefs);
  await db
    .insert(userProfileSettings)
    .values({ userId, settings: { tours: prefs } })
    .onConflictDoUpdate({
      target: userProfileSettings.userId,
      set: {
        settings: sql`${userProfileSettings.settings} || jsonb_build_object('tours', ${json}::jsonb)`,
        updatedAt: new Date(),
      },
    });
};
