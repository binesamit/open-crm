// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { platformSettings, users } from '../../db/schema';

/** The claim row of the first-run setup (platform_settings id `setup`): its primary key makes the claim single. */
const SETUP_ROW = 'setup';

/** A claim older than this with still no user = the claimant crashed mid-way; the next one may take over. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

export const anyUserExists = async (db: Db) => (await db.select({ id: users.id }).from(users).limit(1)).length > 0;

/**
 * Takes the setup for this request: true for exactly one caller, however many arrive at once (the insert either
 * makes the row or does nothing). A claim left by a crashed attempt is taken over after STALE_CLAIM_MS.
 */
export const claimSetup = async (db: Db, email: string): Promise<boolean> => {
  const now = new Date();
  const claim = { claimed_at: now.toISOString(), email };
  const inserted = await db
    .insert(platformSettings)
    .values({ id: SETUP_ROW, settings: claim })
    .onConflictDoNothing()
    .returning({ id: platformSettings.id });
  if (inserted.length) return true;
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const taken = await db
    .update(platformSettings)
    .set({ settings: claim, updatedAt: now })
    .where(
      and(
        eq(platformSettings.id, SETUP_ROW),
        sql`${platformSettings.settings}->>'done_at' is null`,
        sql`${platformSettings.updatedAt} < ${stale.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: platformSettings.id });
  return taken.length > 0;
};

/** A failed attempt (bad password, …) gives the setup back at once. */
export const releaseSetup = (db: Db) => db.delete(platformSettings).where(eq(platformSettings.id, SETUP_ROW));

export const finishSetup = (db: Db, userId: string) =>
  db
    .update(platformSettings)
    .set({ settings: { done_at: new Date().toISOString() }, updatedBy: userId, updatedAt: new Date() })
    .where(eq(platformSettings.id, SETUP_ROW));
