// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import {
  type AccountTicketSettings,
  accountTicketSettingsSchema,
  type HelpdeskSettings,
  helpdeskSettingsSchema,
  type UpdateHelpdeskSettings,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';

/**
 * Settings of the helpdesk. Platform level: the `platform_settings` row `helpdesk` (owner console →
 * Support → Settings); missing = the defaults. Account level: `settings.support_tickets` of the account
 * (Administration → Security), next to the support-access settings.
 */
const ROW_ID = 'helpdesk';

const parse = (raw: unknown): HelpdeskSettings => {
  const parsed = helpdeskSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : helpdeskSettingsSchema.parse({});
};

export const loadHelpdeskSettings = async (db: Db): Promise<HelpdeskSettings> =>
  parse((await db.select().from(platformSettings).where(eq(platformSettings.id, ROW_ID)).limit(1))[0]?.settings);

export const saveHelpdeskSettings = async (db: Db, by: string, patch: UpdateHelpdeskSettings) => {
  const current = await loadHelpdeskSettings(db);
  const next = helpdeskSettingsSchema.parse({
    ...current,
    ...patch,
    business_hours: patch.business_hours ?? current.business_hours,
    access: { ...current.access, ...patch.access },
    email: { ...current.email, ...patch.email },
    csat: { ...current.csat, ...patch.csat },
    context: { ...current.context, ...patch.context },
  });
  await db
    .insert(platformSettings)
    .values({ id: ROW_ID, settings: next, updatedBy: by })
    .onConflictDoUpdate({ target: platformSettings.id, set: { settings: next, updatedBy: by, updatedAt: new Date() } });
  return next;
};

export const loadAccountTicketSettings = async (db: Db, accountId: string): Promise<AccountTicketSettings> => {
  const raw = (await getAccountSettings(db, accountId)) as { support_tickets?: unknown };
  const parsed = accountTicketSettingsSchema.safeParse(raw.support_tickets ?? {});
  return parsed.success ? parsed.data : accountTicketSettingsSchema.parse({});
};

export const saveAccountTicketSettings = async (
  db: Db,
  accountId: string,
  by: string,
  patch: Partial<AccountTicketSettings>,
) => {
  const current = (await getAccountSettings(db, accountId)) as Record<string, unknown>;
  const next = accountTicketSettingsSchema.parse({ ...(await loadAccountTicketSettings(db, accountId)), ...patch });
  await upsertAccountSettings(db, accountId, { ...current, support_tickets: next }, by);
  return next;
};
