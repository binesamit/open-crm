// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { provisionAccount } from '../src/modules/accounts/accounts.service';
import { loadImportRefs, saveImportRef } from '../src/modules/imports/import-refs.repo';
import { createTestContext, type TestContext } from './helpers';

/** Importers' id map (import_refs, migration 0033): per account and source, re-pointable, isolated. */
describe('import refs', () => {
  let t: TestContext;
  let db: Db;
  beforeAll(async () => {
    t = await createTestContext();
    db = t.db as unknown as Db;
  });
  afterAll(() => t.close());

  it('saves, re-points and isolates refs by account and source', async () => {
    const a = await db.transaction((tx) =>
      provisionAccount(tx, { name: 'A', slug: 'refs-a', templateSet: 'empty', createdBy: null }),
    );
    const b = await db.transaction((tx) =>
      provisionAccount(tx, { name: 'B', slug: 'refs-b', templateSet: 'empty', createdBy: null }),
    );
    await saveImportRef(db, {
      accountId: a.id,
      source: 'external',
      externalId: 'rec1',
      entityType: 'item',
      entityId: 'I1',
    });
    await saveImportRef(db, {
      accountId: a.id,
      source: 'external',
      externalId: 'rec1',
      entityType: 'item',
      entityId: 'I2',
    });
    await saveImportRef(db, {
      accountId: a.id,
      source: 'other',
      externalId: 'rec1',
      entityType: 'item',
      entityId: 'I3',
    });
    await saveImportRef(db, {
      accountId: b.id,
      source: 'external',
      externalId: 'rec1',
      entityType: 'item',
      entityId: 'I4',
    });

    const refs = await loadImportRefs(db, a.id, 'external');
    expect([...refs]).toEqual([['rec1', { entityType: 'item', entityId: 'I2' }]]);
    expect((await loadImportRefs(db, b.id, 'external')).get('rec1')?.entityId).toBe('I4');
    expect((await loadImportRefs(db, a.id, 'other')).get('rec1')?.entityId).toBe('I3');
  });
});
