// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { type ErrorHubSettings, errorHubSettingsSchema, type UpdateErrorHubSettings } from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';

/**
 * The errors hub's settings (owner console → Errors & health → Settings): the `platform_settings` row `errors`;
 * missing = the defaults (`errorHubSettingsSchema`). Read by the batched writer on every flush, so cached briefly per
 * database handle; a save clears the cache.
 */
const ROW_ID = 'errors';
const CACHE_MS = 15_000;
const cache = new WeakMap<object, { at: number; value: ErrorHubSettings }>();

const parse = (raw: unknown): ErrorHubSettings => {
  const parsed = errorHubSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : errorHubSettingsSchema.parse({});
};

export const loadErrorHubSettings = async (db: Db): Promise<ErrorHubSettings> => {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, ROW_ID)).limit(1))[0];
  const value = parse(row?.settings);
  cache.set(db, { at: Date.now(), value });
  return value;
};

/** Only the parts sent change; each part is replaced (sources and retention merge per key). */
export const saveErrorHubSettings = async (db: Db, by: string, patch: UpdateErrorHubSettings) => {
  const current = await loadErrorHubSettings(db);
  const next = errorHubSettingsSchema.parse({
    ...current,
    ...patch,
    sources: { ...current.sources, ...patch.sources },
    retention_days: { ...current.retention_days, ...patch.retention_days },
  });
  await db
    .insert(platformSettings)
    .values({ id: ROW_ID, settings: next, updatedBy: by })
    .onConflictDoUpdate({ target: platformSettings.id, set: { settings: next, updatedBy: by, updatedAt: new Date() } });
  cache.delete(db);
  return next;
};
