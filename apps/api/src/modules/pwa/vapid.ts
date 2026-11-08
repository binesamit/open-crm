// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { platformMasterKey, readVapidRow, type VapidRow, vapidRowFor } from '@bines/server-crypto';
import { VAPID_ROW_ID, vapidSubject } from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import type { Env } from '../../env';

/** `privateKey` null = sealed and this process has no SECRET_MASTER_KEY (the API only needs the public key). */
export type Vapid = { publicKey: string; privateKey: string | null; subject: string };

/** A fresh P-256 pair as Web Push wants it: public = uncompressed point (65 bytes), private = d (32 bytes), base64url. */
export const generateVapidKeys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
  return { publicKey: raw.toString('base64url'), privateKey: priv.d! };
};

let cache = new WeakMap<object, Vapid>();
/** Tests: forget the pair read so far (each database handle keeps it for the life of the process). */
export const resetVapidCache = () => {
  cache = new WeakMap();
};

/**
 * The VAPID pair (PWA פ4): VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set (no key is ever in the code), else the
 * pair kept in platform_settings (row `vapid`), created on first need — the worker reads the same row. The row is
 * never part of GET /platform/settings (that reads row `platform` only).
 *
 * At rest (`@bines/server-crypto` → `vapidRowFor` / `readVapidRow`): with SECRET_MASTER_KEY the private key is
 * sealed; an old row in plain is re-sealed the first time it is read with a key. Without the variable nothing
 * changes (plain, as before). The API itself only needs the public key (always readable), so a sealed row and a
 * missing key never break the app here — only the worker's sending needs the private key.
 */
export const loadVapid = async (
  db: Db,
  env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT' | 'WEB_ORIGIN' | 'SECRET_MASTER_KEY'>,
): Promise<Vapid> => {
  const subject = vapidSubject(env.VAPID_SUBJECT, env.WEB_ORIGIN);
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
  const hit = cache.get(db);
  if (hit) return hit;
  const master = platformMasterKey(env.SECRET_MASTER_KEY);
  const read = async () => {
    const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, VAPID_ROW_ID)).limit(1))[0];
    return readVapidRow(row?.settings as VapidRow | undefined, master);
  };
  let stored = await read();
  if (stored.state === 'none') {
    // Two servers starting at once: the first insert wins, both read it back.
    await db
      .insert(platformSettings)
      .values({ id: VAPID_ROW_ID, settings: vapidRowFor(generateVapidKeys(), master) })
      .onConflictDoNothing();
    stored = await read();
  } else if (stored.state === 'ok' && stored.plain && master) {
    // Migrate on read: the plain row of an earlier version is sealed now that a key exists.
    await db
      .update(platformSettings)
      .set({ settings: vapidRowFor(stored.pair, master), updatedAt: new Date() })
      .where(eq(platformSettings.id, VAPID_ROW_ID));
  }
  const pair: Vapid =
    stored.state === 'ok'
      ? { ...stored.pair, subject }
      : { publicKey: stored.state === 'locked' ? stored.publicKey : '', privateKey: null, subject };
  if (pair.publicKey) cache.set(db, pair);
  return pair;
};
