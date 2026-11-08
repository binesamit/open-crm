// SPDX-License-Identifier: AGPL-3.0-only
import { newId } from '@bines/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { importRefs } from '../../db/schema';

/**
 * Importers' id map (any source — `import_refs`): what an external id became here. A re-run of an import looks its
 * rows up instead of creating them again.
 */
export type ImportRef = { entityType: string; entityId: string };

/** Every ref of an account for one source, by external id. */
export const loadImportRefs = async (db: Db, accountId: string, source: string) =>
  new Map(
    (
      await db
        .select({ externalId: importRefs.externalId, entityType: importRefs.entityType, entityId: importRefs.entityId })
        .from(importRefs)
        .where(and(eq(importRefs.accountId, accountId), eq(importRefs.source, source)))
    ).map((r) => [r.externalId, { entityType: r.entityType, entityId: r.entityId } satisfies ImportRef]),
  );

/** Records (or re-points) an external id. */
export const saveImportRef = (
  db: Db,
  row: { accountId: string; source: string; externalId: string; entityType: string; entityId: string },
) =>
  db
    .insert(importRefs)
    .values({ id: newId(), ...row })
    .onConflictDoUpdate({
      target: [importRefs.accountId, importRefs.source, importRefs.externalId],
      set: { entityType: row.entityType, entityId: row.entityId, updatedAt: sql`now()` },
    });
