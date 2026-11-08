// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountGeo, cells, geocodeCache } from '../../db/schema';

/** Maps (M8 ד10): the geocoding cache, the account's sealed Google key, location cells waiting for coordinates. */

export const findCached = async (db: Db, accountId: string, query: string) =>
  (
    await db
      .select()
      .from(geocodeCache)
      .where(and(eq(geocodeCache.accountId, accountId), eq(geocodeCache.query, query)))
      .limit(1)
  )[0];

export const saveCached = (db: Db, row: typeof geocodeCache.$inferInsert) =>
  db
    .insert(geocodeCache)
    .values(row)
    .onConflictDoUpdate({
      target: [geocodeCache.accountId, geocodeCache.query],
      set: { provider: row.provider, found: row.found, lat: row.lat, lng: row.lng, countryCode: row.countryCode },
    });

export const findAccountGeo = async (db: Db, accountId: string) =>
  (await db.select().from(accountGeo).where(eq(accountGeo.accountId, accountId)).limit(1))[0];

export const saveGoogleKey = (db: Db, accountId: string, sealed: string | null, hint: string | null, by: string) =>
  db
    .insert(accountGeo)
    .values({ accountId, googleKey: sealed, googleKeyHint: hint, updatedBy: by })
    .onConflictDoUpdate({
      target: accountGeo.accountId,
      set: { googleKey: sealed, googleKeyHint: hint, updatedBy: by, updatedAt: new Date() },
    });

export const findCell = async (db: Db, itemId: string, columnId: string) =>
  (
    await db
      .select()
      .from(cells)
      .where(and(eq(cells.itemId, itemId), eq(cells.columnId, columnId)))
      .limit(1)
  )[0];

/** Coordinates into a location cell — only while it still holds the address that was looked up. */
export const setCellGeo = async (db: Db, itemId: string, columnId: string, address: string, patch: object) => {
  const res = (await db.execute(sql`
    update cells set value = value || ${JSON.stringify(patch)}::jsonb, updated_at = now()
    where item_id = ${itemId} and column_id = ${columnId} and value->>'address' = ${address}
      and value->'lat' is null
    returning item_id`)) as { rows: unknown[] };
  return res.rows.length > 0;
};

/**
 * Live location cells without coordinates that were never tried and failed (the sweep: imports, bulk edits and
 * anything written outside the cell service). Oldest first.
 */
export const pendingLocationCells = async (db: Db, limit: number) =>
  (
    (await db.execute(sql`
    select c.account_id, c.board_id, c.item_id, c.column_id, c.value->>'address' as address
    from cells c
    join columns col on col.id = c.column_id and col.type = 'location' and col.deleted_at is null
    join items i on i.id = c.item_id and i.deleted_at is null
    left join account_settings s on s.account_id = c.account_id
    where coalesce(s.settings->'maps'->>'geocoder', 'auto') <> 'off' and c.value->'lat' is null and c.value->>'address' is not null
      and coalesce((c.value->>'geocode_failed')::boolean, false) = false
    order by c.updated_at
    limit ${limit}`)) as {
      rows: { account_id: string; board_id: string; item_id: string; column_id: string; address: string }[];
    }
  ).rows;

/** Distinct map origins the accounts chose (their style URL and extra origins), for the CSP. */
export const accountMapSettings = async (db: Db) =>
  (
    (await db.execute(sql`
    select settings->'maps' as maps from account_settings where settings ? 'maps'`)) as {
      rows: { maps: unknown }[];
    }
  ).rows.map((r) => r.maps);
