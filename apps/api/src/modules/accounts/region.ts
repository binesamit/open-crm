// SPDX-License-Identifier: AGPL-3.0-only
import { accountSettingsSchema, columnTypes, resolveRegion, type Region } from '@bines/shared';
import type { Db } from '../../db/client';
import type { SessionUser } from '../../types';
import { accountCalendar } from '../../lib/account-calendar';
import { getAccountSettings } from './accounts.repo';

/**
 * Region settings on the server (A3, ANSWERS §6 #5–7): every text the server writes for people — item DTO dates,
 * exports, automation messages, emails, reports — uses the account's date / time format, timezone and currency;
 * a member reading through the API sees their own language and timezone on top (08 §12.1).
 */
export const accountRegion = async (
  db: Db,
  accountId: string,
  user?: { locale?: string | null; timezone?: string | null } | null,
): Promise<Region> => {
  const raw = await getAccountSettings(db, accountId);
  const settings = accountSettingsSchema.safeParse(raw);
  // The account's calendar: Hebrew dates and working days in what the server writes.
  const calendar = await accountCalendar(db, accountId, raw);
  return resolveRegion(settings.success ? settings.data.locale : null, user, calendar);
};

type RegionActor = {
  ctx: { accountId: string };
  user: Pick<SessionUser, 'locale' | 'timezone' | 'isService'>;
  automation?: unknown;
};

const memo = new WeakMap<object, Promise<Region>>();

/**
 * The region an actor reads in: a person — the account's, with their language and zone; an automation run or a
 * service token — the account's own (they write for everyone). Memoised per actor (one request).
 */
export const actorRegion = (db: Db, a: RegionActor): Promise<Region> => {
  let r = memo.get(a);
  if (!r) {
    r = accountRegion(db, a.ctx.accountId, a.automation || a.user.isService ? null : a.user);
    memo.set(a, r);
  }
  return r;
};

/**
 * A stored cell's text for a reader: date-like columns (`localizedText`) are re-written in the region; others keep
 * the stored `text_value`. For reads that skip the Calculator (My Work, webhooks).
 */
export const regionCellText = (
  type: string,
  settings: unknown,
  value: unknown,
  stored: string | null,
  region: Region,
): string | null => {
  const def = columnTypes.get(type);
  if (!def?.localizedText || value === null || value === undefined) return stored;
  try {
    return def.toText(value, { ...(def.defaultSettings as object), ...(settings as object) }, { region }) || null;
  } catch {
    return stored;
  }
};
