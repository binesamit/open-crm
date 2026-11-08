// SPDX-License-Identifier: AGPL-3.0-only
import { accountSettingsSchema, resolveCalendar, type CalendarConfig } from '@bines/shared';
import type { Db } from '../db/client';
import { getAccountSettings } from '../modules/accounts/accounts.repo';
import { loadPlatformSettings } from '../modules/platform/platform-settings';

/**
 * The calendar an account works by: the owner's defaults with the account's own choices on top.
 * Working-day math on the server (filters, formulas, automations, dependencies) reads it from here. Pass the
 * account settings when they are already loaded (then no second read).
 */
export const accountCalendar = async (
  db: Db,
  accountId: string,
  accountSettings?: unknown,
): Promise<CalendarConfig> => {
  const [platform, raw] = await Promise.all([
    loadPlatformSettings(db),
    accountSettings === undefined ? getAccountSettings(db, accountId) : accountSettings,
  ]);
  const parsed = accountSettingsSchema.safeParse(raw ?? {});
  return resolveCalendar(platform.calendar, parsed.success ? parsed.data.calendar : undefined);
};

/** The account's weekend and calendar together (working-day math needs both), from one read of its settings. */
export const accountWorkCalendar = async (
  db: Db,
  accountId: string,
): Promise<{ weekend: 'fri_sat' | 'sat_sun'; calendar: CalendarConfig }> => {
  const raw = await getAccountSettings(db, accountId);
  const parsed = accountSettingsSchema.safeParse(raw ?? {});
  return {
    weekend: parsed.success ? parsed.data.locale.weekend : 'fri_sat',
    calendar: await accountCalendar(db, accountId, raw),
  };
};
