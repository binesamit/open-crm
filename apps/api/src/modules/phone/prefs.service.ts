// SPDX-License-Identifier: AGPL-3.0-only
import { eq, sql } from 'drizzle-orm';
import {
  cleanPhonePrefs,
  DEFAULT_PHONE_PREFS,
  type PhoneActionPrefs,
  type PhoneActionPrefsResponse,
  type SetPhoneActionPrefs,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { userProfileSettings } from '../../db/schema';
import type { SessionUser } from '../../types';

/**
 * Plan: what a click on a phone number does for this person (`user_profile_settings.settings.phone_actions`)
 * — one value per user, every device and account. Same merge pattern as `me/appearance.ts`.
 */
const storedOf = async (db: Db, userId: string) => {
  const row = (
    await db
      .select({ prefs: sql<unknown>`${userProfileSettings.settings}->'phone_actions'` })
      .from(userProfileSettings)
      .where(eq(userProfileSettings.userId, userId))
      .limit(1)
  )[0];
  return cleanPhonePrefs(row?.prefs ?? null);
};

export const myPhonePrefs = async (db: Db, user: SessionUser): Promise<PhoneActionPrefsResponse> => {
  const mine = await storedOf(db, user.id);
  return { ...DEFAULT_PHONE_PREFS, ...mine, user: mine };
};

/** PUT /me/phone-actions — merges into the stored choice (`null` = back to the default). */
export const setMyPhonePrefs = async (
  db: Db,
  user: SessionUser,
  patch: SetPhoneActionPrefs,
): Promise<PhoneActionPrefsResponse> => {
  const next: Partial<PhoneActionPrefs> = { ...(await storedOf(db, user.id)) };
  for (const key of ['click', 'whatsapp_desktop', 'sms_mobile'] as const) {
    const v = patch[key];
    if (v === null) delete next[key];
    else if (v !== undefined) (next as Record<string, string>)[key] = v;
  }
  const json = JSON.stringify(next);
  await db
    .insert(userProfileSettings)
    .values({ userId: user.id, settings: { phone_actions: next } })
    .onConflictDoUpdate({
      target: userProfileSettings.userId,
      set: {
        settings: sql`${userProfileSettings.settings} || jsonb_build_object('phone_actions', ${json}::jsonb)`,
        updatedAt: new Date(),
      },
    });
  return myPhonePrefs(db, user);
};
