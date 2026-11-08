// SPDX-License-Identifier: AGPL-3.0-only
import { accountSettingsSchema, columnTypes, type AnyColumnTypeDef } from '@bines/shared';
import type { Db } from '../../db/client';
import { getAccountSettings } from '../accounts/accounts.repo';
import { columnPhoneCells, phoneCellsPage, updateCellValues } from './phone.repo';

/**
 * Plan — the derived keys of stored values (phone `e164` / `valid`): kept current when a column's settings
 * change, and filled in for cells written before (the backfill script). Generic over `ColumnTypeDef.normalize`.
 */

/** The account's country (`locale.country`): the last fallback for numbers typed without a country code. */
export const accountCountry = async (db: Db, accountId: string): Promise<string> => {
  const parsed = accountSettingsSchema.safeParse(await getAccountSettings(db, accountId));
  return parsed.success ? parsed.data.locale.country : 'IL';
};

/** Key-order-insensitive (JSONB does not keep key order). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The value as `normalize` would store it now, or null when it is not a valid value of the type. */
const normalized = (def: AnyColumnTypeDef, settings: unknown, value: unknown, country: string): unknown => {
  const v = def.valueSchema.safeParse(value);
  if (!v.success || !def.normalize) return null;
  return def.normalize(v.data, settings, { country });
};

/**
 * After a column's settings changed (a phone column's default country): recomputes the derived keys of every cell
 * of the column and rewrites the ones that moved. No events — what people see does not change.
 */
export const renormalizeColumn = async (
  tx: Db,
  column: { id: string; type: string; accountId: string },
  settings: unknown,
) => {
  const def = columnTypes.get(column.type);
  if (!def?.normalize) return 0;
  const country = await accountCountry(tx, column.accountId);
  const rows = (await columnPhoneCells(tx, column.id)).flatMap((c) => {
    const next = normalized(def, settings, c.value, country);
    return next && !same(next, c.value) ? [{ itemId: c.itemId, columnId: column.id, value: next }] : [];
  });
  await updateCellValues(tx, rows);
  return rows.length;
};

export type BackfillStats = { scanned: number; changed: number; valid: number; invalid: number; skipped: number };

/**
 * Fills `e164` / `valid` into every phone cell (or one account's). `apply: false` (the default of the script) only
 * counts what would change. Idempotent: a second run changes nothing.
 */
export const backfillPhoneCells = async (
  db: Db,
  opts: { apply: boolean; accountId?: string; batch?: number; onBatch?: (s: BackfillStats) => void },
): Promise<BackfillStats> => {
  const def = columnTypes.get('phone')!;
  const stats: BackfillStats = { scanned: 0, changed: 0, valid: 0, invalid: 0, skipped: 0 };
  const countries = new Map<string, string>();
  let after: { columnId: string; itemId: string } | null = null;
  for (;;) {
    const page = await phoneCellsPage(db, after, opts.batch ?? 500, opts.accountId);
    if (!page.length) break;
    const writes: { itemId: string; columnId: string; value: unknown }[] = [];
    for (const row of page) {
      stats.scanned += 1;
      if (!countries.has(row.accountId)) countries.set(row.accountId, await accountCountry(db, row.accountId));
      const next = normalized(def, row.settings, row.value, countries.get(row.accountId)!);
      if (!next) {
        stats.skipped += 1;
        continue;
      }
      if ((next as { valid?: boolean }).valid) stats.valid += 1;
      else stats.invalid += 1;
      if (!same(next, row.value)) writes.push({ itemId: row.itemId, columnId: row.columnId, value: next });
    }
    stats.changed += writes.length;
    if (opts.apply && writes.length) await updateCellValues(db, writes);
    const last = page[page.length - 1]!;
    after = { columnId: last.columnId, itemId: last.itemId };
    opts.onBatch?.({ ...stats });
  }
  return stats;
};
