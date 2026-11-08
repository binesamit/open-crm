// SPDX-License-Identifier: AGPL-3.0-only
import { eq, sql } from 'drizzle-orm';
import {
  type AppearanceResponse,
  cleanAppearance,
  cleanEmailOpen,
  cleanIconStyle,
  DEFAULT_EMAIL_OPEN,
  DEFAULT_ICON_STYLE,
  isId,
  resolveAppearance,
  type SetAppearance,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { userProfileSettings } from '../../db/schema';
import type { SessionUser } from '../../types';
import { findMembership, getAccountSettings } from '../accounts/accounts.repo';

/**
 * Round 13: the user's text size and table density (`user_profile_settings.settings.appearance`) — one value per
 * user, every device. The account's default (`account_settings.settings.appearance`) is read when the request names
 * an account the user is an active member of: the hook for an admin's "default text size" (its editor belongs to
 * the account settings screen — not built here); a user's own choice always wins.
 */
const storedOf = async (db: Db, userId: string) => {
  const row = (
    await db
      .select({ appearance: sql<unknown>`${userProfileSettings.settings}->'appearance'` })
      .from(userProfileSettings)
      .where(eq(userProfileSettings.userId, userId))
      .limit(1)
  )[0];
  return cleanAppearance((row?.appearance ?? null) as Record<string, unknown> | null);
};

/** The account's default appearance, when the user is an active member there; null otherwise / none set. */
export const accountAppearanceDefault = async (db: Db, userId: string, accountId?: string | null) => {
  if (!accountId || !isId(accountId)) return null;
  const membership = await findMembership(db, accountId, userId);
  if (membership?.status !== 'active') return null;
  const settings = (await getAccountSettings(db, accountId)) as {
    appearance?: Record<string, unknown>;
    defaults?: { icon_style?: unknown; email_open?: unknown };
  };
  const d = cleanAppearance(settings.appearance ?? null);
  // The account's default card width lives in `defaults.card_width_pct` (F9 cardw), not here.
  delete d.card_width;
  // the icon style is edited with the other defaults (Administration → General).
  const iconStyle = cleanIconStyle(settings.defaults?.icon_style);
  if (iconStyle) d.icon_style = iconStyle;
  else delete d.icon_style;
  // the email-click choice too.
  const emailOpen = cleanEmailOpen(settings.defaults?.email_open);
  if (emailOpen) d.email_open = emailOpen;
  else delete d.email_open;
  return d.text_size || d.density || d.motion || d.icon_style || d.email_open ? d : null;
};

export const myAppearance = async (
  db: Db,
  user: SessionUser,
  accountId?: string | null,
): Promise<AppearanceResponse> => {
  const [mine, fallback] = await Promise.all([storedOf(db, user.id), accountAppearanceDefault(db, user.id, accountId)]);
  return {
    ...resolveAppearance(mine, fallback),
    motion: mine.motion ?? fallback?.motion ?? 'system',
    card_width: mine.card_width ?? null,
    icon_style: mine.icon_style ?? fallback?.icon_style ?? DEFAULT_ICON_STYLE,
    email_open: mine.email_open ?? fallback?.email_open ?? DEFAULT_EMAIL_OPEN,
    user: mine,
    account_default: fallback,
  };
};

/** PUT /me/appearance — merges into the stored choice (`null` = back to the default). */
export const setMyAppearance = async (
  db: Db,
  user: SessionUser,
  patch: SetAppearance,
  accountId?: string | null,
): Promise<AppearanceResponse> => {
  const next: Record<string, string | number> = { ...(await storedOf(db, user.id)) };
  for (const key of ['text_size', 'density', 'motion', 'card_width', 'icon_style', 'email_open'] as const) {
    const v = patch[key];
    if (v === null) delete next[key];
    else if (v !== undefined) next[key] = v;
  }
  const json = JSON.stringify(next);
  await db
    .insert(userProfileSettings)
    .values({ userId: user.id, settings: { appearance: next } })
    .onConflictDoUpdate({
      target: userProfileSettings.userId,
      set: {
        settings: sql`${userProfileSettings.settings} || jsonb_build_object('appearance', ${json}::jsonb)`,
        updatedAt: new Date(),
      },
    });
  return myAppearance(db, user, accountId);
};
