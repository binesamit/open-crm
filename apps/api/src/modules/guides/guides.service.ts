// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  type CreateOwnerGuide,
  type GuideLocale,
  type InstallGuide,
  newId,
  type OwnerGuide,
  type UpdateOwnerGuide,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { ownerGuides } from '../../db/schema';
import type { AppDeps, SessionUser } from '../../types';
import { docsBrandOf } from '../apidocs/apidocs.routes';
import { renderInstallGuideBody } from '../apidocs/install-guide';
import { loadPlatformSettings } from '../platform/platform-settings';

/**
 * Guides: the installation and licensing guide for the app (the bundled docs/GUIDE*.md, the same
 * text as the public /api/docs/guide pages), and the platform owner's own guides — Markdown pages in the database,
 * private to the owner (owner console → Guides), created / edited / reordered / deleted there or through the API.
 */
type Deps = Pick<AppDeps, 'db' | 'env'>;
type Row = typeof ownerGuides.$inferSelect;

/** Rendered once per language and brand (Platform settings are cached ~30 s in this process). */
const installCache = new Map<string, InstallGuide>();

/** GET /guides/install: the guide in one language, white-labelled with the owner's product name. */
export const getInstallGuide = async (deps: Deps, locale: GuideLocale): Promise<InstallGuide> => {
  const brand = docsBrandOf(deps.env, await loadPlatformSettings(deps.db));
  const key = JSON.stringify([locale, brand.productName]);
  let doc = installCache.get(key);
  if (!doc) {
    doc = { ...renderInstallGuideBody(locale, { productName: brand.productName }), product_name: brand.productName };
    if (installCache.size > 20) installCache.clear();
    installCache.set(key, doc);
  }
  return doc;
};

// ------------------------------------------------------------------------------------------------ owner guides

const toGuide = (r: Row): OwnerGuide => ({
  id: r.id,
  title: { he: r.title.he ?? '', en: r.title.en ?? '' },
  body: { he: r.body.he ?? '', en: r.body.en ?? '' },
  sort_order: r.sortOrder,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

const live = isNull(ownerGuides.deletedAt);

const findGuide = async (db: Db, id: string) => {
  const row = (
    await db
      .select()
      .from(ownerGuides)
      .where(and(eq(ownerGuides.id, id), live))
      .limit(1)
  )[0];
  if (!row) throw new AppError('not_found', 'Guide not found');
  return row;
};

const merge = (base: { he: string; en: string }, patch?: { he?: string; en?: string }) => ({
  he: patch?.he ?? base.he,
  en: patch?.en ?? base.en,
});

export const listOwnerGuides = async ({ db }: Deps): Promise<OwnerGuide[]> =>
  (await db.select().from(ownerGuides).where(live).orderBy(asc(ownerGuides.sortOrder), asc(ownerGuides.id))).map(
    toGuide,
  );

export const getOwnerGuide = async ({ db }: Deps, id: string) => toGuide(await findGuide(db, id));

/** Adds a guide at the end of the list. */
export const createOwnerGuide = async ({ db }: Deps, owner: SessionUser, input: CreateOwnerGuide) => {
  const max =
    (
      await db
        .select({ max: sql<number>`coalesce(max(${ownerGuides.sortOrder}), 0)` })
        .from(ownerGuides)
        .where(live)
    )[0]?.max ?? 0;
  const [row] = await db
    .insert(ownerGuides)
    .values({
      id: newId(),
      title: merge({ he: '', en: '' }, input.title),
      body: merge({ he: '', en: '' }, input.body),
      sortOrder: Number(max) + 10,
      updatedBy: owner.id,
    })
    .returning();
  return toGuide(row!);
};

export const updateOwnerGuide = async ({ db }: Deps, owner: SessionUser, id: string, patch: UpdateOwnerGuide) => {
  const row = await findGuide(db, id);
  const title = merge(row.title, patch.title);
  if (!title.he.trim() && !title.en.trim())
    throw new AppError('validation_failed', 'A guide needs a title in at least one language', { field: 'title' });
  const [updated] = await db
    .update(ownerGuides)
    .set({ title, body: merge(row.body, patch.body), updatedBy: owner.id, updatedAt: new Date() })
    .where(eq(ownerGuides.id, row.id))
    .returning();
  return toGuide(updated!);
};

/** Puts the guides in the given order (every live guide's id, each once). */
export const reorderOwnerGuides = async ({ db }: Deps, ids: string[]) => {
  const rows = await db.select({ id: ownerGuides.id }).from(ownerGuides).where(live);
  const known = new Set(rows.map((r) => r.id));
  if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some((id) => !known.has(id)))
    throw new AppError('validation_failed', 'Send every guide exactly once', { field: 'ids' });
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries())
      await tx
        .update(ownerGuides)
        .set({ sortOrder: (i + 1) * 10 })
        .where(eq(ownerGuides.id, id));
  });
  return listOwnerGuides({ db } as Deps);
};

/** Soft delete (rule 3): the guide leaves the console at once. */
export const deleteOwnerGuide = async ({ db }: Deps, owner: SessionUser, id: string) => {
  const row = await findGuide(db, id);
  await db
    .update(ownerGuides)
    .set({ deletedAt: new Date(), updatedBy: owner.id, updatedAt: new Date() })
    .where(eq(ownerGuides.id, row.id));
};
