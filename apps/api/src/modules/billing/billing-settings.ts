// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { type BillingSettings, billingSettingsSchema, mergeNullable, type UpdateBillingSettings } from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import type { SessionUser } from '../../types';
import { announceSettingsChange } from './plan-status';

/**
 * Owner console → Plans → settings: the warning share, the grace periods and what each status
 * becomes, the upgrade text / link and the feature catalogue. One `platform_settings` row (id `billing`) beside the
 * platform's own; missing = the defaults. Read on hot paths (entitlements), so cached briefly.
 */
const ROW_ID = 'billing';
const CACHE_MS = 30_000;
let cache: { at: number; value: BillingSettings } | null = null;

const parse = (raw: unknown): BillingSettings => {
  const parsed = billingSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : billingSettingsSchema.parse({});
};

export const loadBillingSettings = async (db: Db): Promise<BillingSettings> => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, ROW_ID)).limit(1))[0];
  const value = parse(row?.settings);
  cache = { at: Date.now(), value };
  return value;
};

/** PATCH /platform/billing-settings: only what is sent changes; null = back to the default. */
export const updateBillingSettings = async (db: Db, owner: SessionUser, patch: UpdateBillingSettings) => {
  const current = await loadBillingSettings(db);
  // The texts: null = cleared. The day counts: null is a value of its own ("never by itself").
  const { upgrade_text, upgrade_url, closed_text, contact_url, ...rest } = patch;
  const texts = mergeNullable(current as Record<string, unknown>, {
    upgrade_text,
    upgrade_url,
    closed_text,
    contact_url,
  });
  const others = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const next = billingSettingsSchema.parse({ ...texts, ...others });
  await db
    .insert(platformSettings)
    .values({ id: ROW_ID, settings: next, updatedBy: owner.id })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { settings: next, updatedBy: owner.id, updatedAt: new Date() },
    });
  cache = null;
  // Accounts whose status moved with the new settings hear about it (account.plan_changed, plans).
  await announceSettingsChange(db, current, next);
  return next;
};

/** Tests and owner writes: forget the cached settings. */
export const forgetBillingSettings = () => {
  cache = null;
};
