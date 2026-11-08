// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import {
  type AccountHelpAi,
  accountHelpAiSchema,
  type HelpCenterSettings,
  helpCenterSettingsSchema,
  type HelpCenterSettingsDto,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';

/**
 * Settings of the knowledge center. Platform level: the `platform_settings` row `help_center` (owner
 * console → Support → Knowledge → Settings); missing = the defaults. Account level: `settings.help_ai` — which AI
 * connection answers the account's help assistant (the platform's, capped, or the account's own).
 */
const ROW_ID = 'help_center';

const parse = (raw: unknown): HelpCenterSettings => {
  const parsed = helpCenterSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : helpCenterSettingsSchema.parse({});
};

export const loadHelpSettings = async (db: Db): Promise<HelpCenterSettings> =>
  parse((await db.select().from(platformSettings).where(eq(platformSettings.id, ROW_ID)).limit(1))[0]?.settings);

export const storeHelpSettings = async (db: Db, by: string, next: HelpCenterSettings) => {
  const value = helpCenterSettingsSchema.parse(next);
  await db
    .insert(platformSettings)
    .values({ id: ROW_ID, settings: value, updatedBy: by })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { settings: value, updatedBy: by, updatedAt: new Date() },
    });
  return value;
};

/** The base of every help article link (decision a): the help center's address when set, else the app's. */
export const helpLinkBase = (s: Pick<HelpCenterSettings, 'base_url'>, origin: string) => s.base_url || origin;

/** What the console sees: never the sealed key. */
export const helpSettingsDto = (s: HelpCenterSettings): HelpCenterSettingsDto => {
  const { key_enc, ...ai } = s.ai;
  return { ...s, ai: { ...ai, has_key: !!key_enc } };
};

export const loadAccountHelpAi = async (db: Db, accountId: string): Promise<AccountHelpAi> => {
  const raw = (await getAccountSettings(db, accountId)) as { help_ai?: unknown };
  const parsed = accountHelpAiSchema.safeParse(raw.help_ai ?? {});
  return parsed.success ? parsed.data : accountHelpAiSchema.parse({});
};

export const saveAccountHelpAi = async (db: Db, accountId: string, by: string, patch: Partial<AccountHelpAi>) => {
  const current = (await getAccountSettings(db, accountId)) as Record<string, unknown>;
  const next = accountHelpAiSchema.parse({ ...(await loadAccountHelpAi(db, accountId)), ...patch });
  await upsertAccountSettings(db, accountId, { ...current, help_ai: next }, by);
  return next;
};
