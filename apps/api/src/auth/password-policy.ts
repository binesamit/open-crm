// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { AppError, passwordLengthProblem, passwordMinLengthSchema } from '@bines/shared';
import type { Db } from '../db/client';
import { accountMembers, accountSettings } from '../db/schema';
import { loadPlatformSettings } from '../modules/platform/platform-settings';

/**
 * The one place that says how long a new password must be (the rule in @bines/shared `api/password.ts`).
 * Better Auth's own `minPasswordLength` is the lowest value any setting may take (PASSWORD_MIN_FLOOR); the configured
 * minimum is checked here, before Better Auth stores the password (auth.ts hooks.before, POST /me/password).
 */

/** The account's own minimum (`settings.security.password_min_length`), undefined = not set. */
const ownMin = (settings: unknown): number | undefined => {
  const raw = (settings as { security?: { password_min_length?: unknown } } | undefined)?.security?.password_min_length;
  const parsed = passwordMinLengthSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

/** The platform owner's default (owner console → Platform settings). */
export const platformPasswordMin = async (db: Db) => (await loadPlatformSettings(db)).password.min_length;

/** One account's minimum: its own, else the platform's. */
export const accountPasswordMin = async (db: Db, accountId: string) => {
  const row = (await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1))[0];
  return ownMin(row?.settings) ?? (await platformPasswordMin(db));
};

/**
 * A person's minimum: the strictest (longest) of the accounts they are an active member of — one password opens
 * all of them, so it must satisfy each — else the platform's (no account yet, the platform owner).
 */
export const userPasswordMin = async (db: Db, userId: string) => {
  const platform = await platformPasswordMin(db);
  const ids = (
    await db
      .select({ id: accountMembers.accountId })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.status, 'active')))
  ).map((r) => r.id);
  if (!ids.length) return platform;
  const rows = await db.select().from(accountSettings).where(inArray(accountSettings.accountId, ids));
  const own = new Map(rows.map((r) => [r.accountId, ownMin(r.settings)]));
  return Math.max(...ids.map((id) => own.get(id) ?? platform));
};

/** 400 `password_min_length` (details.min_length) when the password is shorter than the minimum. */
export const assertPasswordLength = (password: string, minLength: number) => {
  const problem = passwordLengthProblem(password, minLength);
  if (problem === 'too_short') throw new AppError('invalid_value', 'password_min_length', { min_length: minLength });
  if (problem === 'too_long') throw new AppError('invalid_value', 'password_too_long');
};
