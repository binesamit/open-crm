// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { insertSettingsRowIfMissing, readSettingsRow, writeSettingsRow } from './license.repo';

/**
 * This installation's id (docs/LICENSING.md): a random UUID made once — on first boot, or on first use, whichever
 * comes first — and kept in the `platform_settings` row `instance`. A license key may name it (`instance_id`), so a
 * key copied to another server does not work there. It identifies nothing else: no host name, no address.
 */
const ROW_ID = 'instance';
const cache = new WeakMap<object, string>();

const idOf = (row: Record<string, unknown> | null) => (typeof row?.id === 'string' && row.id ? row.id : null);

export const getInstanceId = async (db: Db): Promise<string> => {
  const hit = cache.get(db);
  if (hit) return hit;
  const fresh = () => ({ id: randomUUID(), created_at: new Date().toISOString() });
  let id = idOf(await readSettingsRow(db, ROW_ID));
  // Two processes booting at once: the first insert wins, both read the same id back.
  id ??= idOf(await insertSettingsRowIfMissing(db, ROW_ID, fresh()));
  if (!id) {
    // A row without an id (never written by this code): replace it.
    const row = fresh();
    await writeSettingsRow(db, ROW_ID, row, null);
    id = row.id;
  }
  cache.set(db, id);
  return id;
};

/** First boot: make the id now (index.ts). */
export const ensureInstanceId = getInstanceId;
