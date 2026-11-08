// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  accounts,
  automations,
  extensionInstallations,
  extensionKills,
  extensionStorage,
  extensions,
  users,
} from '../../db/schema';

/** Extensions (D27): the catalog / private manifests, installations per account and the kill switch. */
export type ExtensionRow = typeof extensions.$inferSelect;
export type InstallationRow = typeof extensionInstallations.$inferSelect;

// ---- extensions (manifests) ----

/** The platform catalog (account_id null) — seed/packs. */
export const listCatalog = (db: Db) =>
  db
    .select()
    .from(extensions)
    .where(and(isNull(extensions.accountId), isNull(extensions.deletedAt)))
    .orderBy(extensions.key);

export const findCatalogEntry = async (db: Db, key: string) =>
  (
    await db
      .select()
      .from(extensions)
      .where(and(isNull(extensions.accountId), eq(extensions.key, key), isNull(extensions.deletedAt)))
      .limit(1)
  )[0];

/** The newest catalog row of a key, removed ones included (seeding must not bring back what the owner removed). */
export const findCatalogEntryAny = async (db: Db, key: string) =>
  (
    await db
      .select()
      .from(extensions)
      .where(and(isNull(extensions.accountId), eq(extensions.key, key)))
      .orderBy(sql`${extensions.createdAt} desc`)
      .limit(1)
  )[0];

export const findAccountExtension = async (db: Db, accountId: string, key: string) =>
  (
    await db
      .select()
      .from(extensions)
      .where(and(eq(extensions.accountId, accountId), eq(extensions.key, key), isNull(extensions.deletedAt)))
      .limit(1)
  )[0];

export const insertExtension = (db: Db, row: typeof extensions.$inferInsert) => db.insert(extensions).values(row);

export const updateExtensionRow = (db: Db, id: string, patch: Partial<typeof extensions.$inferInsert>) =>
  db
    .update(extensions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(extensions.id, id));

/** `pnpm db:seed`: a catalog pack upserted by key (a newer manifest replaces the older one). */
export const upsertCatalogExtension = async (db: Db, row: typeof extensions.$inferInsert) => {
  const existing = await findCatalogEntry(db, row.key);
  if (existing) {
    await updateExtensionRow(db, existing.id, {
      name: row.name,
      version: row.version,
      kind: row.kind,
      manifest: row.manifest,
      // A seeded first-party sample keeps its review (round 13); packs have none.
      ...(row.review ? { review: row.review, publishedAt: existing.publishedAt ?? row.publishedAt } : {}),
    });
    return existing.id;
  }
  await insertExtension(db, row);
  return row.id;
};

// ---- installations ----

export const listInstallations = (db: Db, accountId: string) =>
  db
    .select()
    .from(extensionInstallations)
    .where(and(eq(extensionInstallations.accountId, accountId), isNull(extensionInstallations.uninstalledAt)))
    .orderBy(extensionInstallations.createdAt);

/** Including an uninstalled one (a reinstall reuses the row — and its pack state). */
export const findInstallationByKey = async (db: Db, accountId: string, key: string) =>
  (
    await db
      .select()
      .from(extensionInstallations)
      .where(and(eq(extensionInstallations.accountId, accountId), eq(extensionInstallations.key, key)))
      .limit(1)
  )[0];

export const findInstallation = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(extensionInstallations)
      .where(
        and(
          eq(extensionInstallations.accountId, accountId),
          eq(extensionInstallations.id, id),
          isNull(extensionInstallations.uninstalledAt),
        ),
      )
      .limit(1)
  )[0];

/** For a token check on every request: the installation by id alone (its account is compared by the caller). */
export const findInstallationById = async (db: Db, id: string) =>
  (await db.select().from(extensionInstallations).where(eq(extensionInstallations.id, id)).limit(1))[0];

export const insertInstallation = (db: Db, row: typeof extensionInstallations.$inferInsert) =>
  db.insert(extensionInstallations).values(row);

export const updateInstallationRow = (db: Db, id: string, patch: Partial<typeof extensionInstallations.$inferInsert>) =>
  db
    .update(extensionInstallations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(extensionInstallations.id, id));

/** Enabled code installations of one account (by slug) — their frame origins go into that page's CSP. */
export const enabledInstallationsBySlug = (db: Db, slug: string) =>
  db
    .select({ manifest: extensionInstallations.manifest, key: extensionInstallations.key })
    .from(extensionInstallations)
    .innerJoin(accounts, eq(accounts.id, extensionInstallations.accountId))
    .where(
      and(
        eq(accounts.slug, slug),
        isNull(accounts.deletedAt),
        eq(extensionInstallations.status, 'enabled'),
        isNull(extensionInstallations.uninstalledAt),
      ),
    );

/** Every enabled installation's manifest (CORS: the origins extension iframes may call the API from). */
export const allEnabledManifests = (db: Db) =>
  db
    .select({ manifest: extensionInstallations.manifest, key: extensionInstallations.key })
    .from(extensionInstallations)
    .where(and(eq(extensionInstallations.status, 'enabled'), isNull(extensionInstallations.uninstalledAt)));

export const installCountsByKey = async (db: Db) =>
  new Map(
    (
      await db
        .select({ key: extensionInstallations.key, n: count() })
        .from(extensionInstallations)
        .where(isNull(extensionInstallations.uninstalledAt))
        .groupBy(extensionInstallations.key)
    ).map((r) => [r.key, Number(r.n)]),
  );

/** Keys installed anywhere, with a name (the owner console lists private extensions too). */
export const installedKeys = (db: Db) =>
  db
    .selectDistinctOn([extensionInstallations.key], {
      key: extensionInstallations.key,
      manifest: extensionInstallations.manifest,
    })
    .from(extensionInstallations)
    .where(isNull(extensionInstallations.uninstalledAt))
    .orderBy(extensionInstallations.key, sql`${extensionInstallations.updatedAt} desc`);

// ---- kill switch ----

export const listKills = (db: Db) => db.select().from(extensionKills);

export const findKill = async (db: Db, key: string) =>
  (await db.select().from(extensionKills).where(eq(extensionKills.key, key)).limit(1))[0];

export const killedKeys = async (db: Db, keys: string[]) =>
  keys.length
    ? new Set(
        (
          await db.select({ key: extensionKills.key }).from(extensionKills).where(inArray(extensionKills.key, keys))
        ).map((r) => r.key),
      )
    : new Set<string>();

export const insertKill = (db: Db, row: typeof extensionKills.$inferInsert) =>
  db
    .insert(extensionKills)
    .values(row)
    .onConflictDoUpdate({ target: extensionKills.key, set: { reason: row.reason, killedBy: row.killedBy } });

export const deleteKill = (db: Db, key: string) => db.delete(extensionKills).where(eq(extensionKills.key, key));

export const userBasics = async (db: Db, id: string) =>
  (
    await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerified: users.emailVerified,
        locale: users.locale,
        timezone: users.timezone,
        isService: users.isService,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
  )[0];

// ---- the extension's own storage (ת5) ----

export type StorageRow = typeof extensionStorage.$inferSelect;

const storageOwner = (installationId: string, userId: string | null) =>
  and(
    eq(extensionStorage.installationId, installationId),
    userId ? eq(extensionStorage.userId, userId) : isNull(extensionStorage.userId),
  );

export const findStorage = async (db: Db, installationId: string, userId: string | null, key: string) =>
  (
    await db
      .select()
      .from(extensionStorage)
      .where(and(storageOwner(installationId, userId), eq(extensionStorage.key, key)))
      .limit(1)
  )[0];

export const listStorage = (db: Db, installationId: string, userId: string | null, prefix = '') =>
  db
    .select({ key: extensionStorage.key, size: extensionStorage.size, updatedAt: extensionStorage.updatedAt })
    .from(extensionStorage)
    .where(
      and(
        storageOwner(installationId, userId),
        prefix ? sql`starts_with(${extensionStorage.key}, ${prefix})` : undefined,
      ),
    )
    .orderBy(extensionStorage.key)
    .limit(500);

/** Bytes and keys an installation stores, all its users together (the quota). */
export const storageUsage = async (db: Db, installationId: string) => {
  const r = (
    await db
      .select({ bytes: sql<number>`coalesce(sum(${extensionStorage.size}), 0)`, keys: count() })
      .from(extensionStorage)
      .where(eq(extensionStorage.installationId, installationId))
  )[0];
  return { bytes: Number(r?.bytes ?? 0), keys: Number(r?.keys ?? 0) };
};

export const insertStorage = (db: Db, row: typeof extensionStorage.$inferInsert) =>
  db.insert(extensionStorage).values(row);

export const updateStorageValue = (db: Db, id: string, value: unknown, size: number) =>
  db.update(extensionStorage).set({ value, size, updatedAt: new Date() }).where(eq(extensionStorage.id, id));

export const deleteStorage = (db: Db, installationId: string, userId: string | null, key: string) =>
  db
    .delete(extensionStorage)
    .where(and(storageOwner(installationId, userId), eq(extensionStorage.key, key)))
    .returning({ id: extensionStorage.id });

/** Everything an installation stored (both scopes) — it ends with the installation. */
export const clearStorage = (db: Db, installationId: string) =>
  db.delete(extensionStorage).where(eq(extensionStorage.installationId, installationId));

/** "Save as pack": the live automations of these boards (their recipes go into the pack). */
export const automationsOfBoards = (db: Db, accountId: string, boardIds: string[]) =>
  boardIds.length
    ? db
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.accountId, accountId),
            inArray(automations.boardId, boardIds),
            isNull(automations.deletedAt),
          ),
        )
    : Promise.resolve([] as (typeof automations.$inferSelect)[]);
