// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { type SignupSettings, signupSettingsSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';

/**
 * Self sign-up settings (D32; owner console → Plans → Self sign-up): one `platform_settings` row (id `signup`); a
 * missing row = the defaults, switched OFF. Read on every public sign-up call, so cached briefly per database.
 */
export const SIGNUP_ROW = 'signup';
const CACHE_MS = 30_000;
const cache = new WeakMap<object, { at: number; value: SignupSettings }>();

const parse = (raw: unknown): SignupSettings => {
  const parsed = signupSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : signupSettingsSchema.parse({});
};

export const loadSignupSettings = async (db: Db): Promise<SignupSettings> => {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, SIGNUP_ROW)).limit(1))[0];
  const value = parse(row?.settings);
  cache.set(db, { at: Date.now(), value });
  return value;
};

/** Tests and owner writes: read the row again. */
export const forgetSignupSettings = (db: Db) => cache.delete(db);

export const saveSignupSettings = async (db: Db, by: string | null, next: SignupSettings) => {
  await db
    .insert(platformSettings)
    .values({ id: SIGNUP_ROW, settings: next, updatedBy: by })
    .onConflictDoUpdate({ target: platformSettings.id, set: { settings: next, updatedBy: by, updatedAt: new Date() } });
  forgetSignupSettings(db);
};
