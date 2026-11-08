// SPDX-License-Identifier: AGPL-3.0-only
import { hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Env } from '../../env';
import { gcmOpen, gcmSeal, parseKey32 } from '../../lib/secrets';
import { findWrappedKey, insertWrappedKey } from './secrets.repo';

/**
 * Envelope encryption of secret columns
 * - the platform master key `SECRET_MASTER_KEY` (env, 32 bytes) wraps one random 32-byte data key per account
 *   (`account_secret_keys`, AES-256-GCM, bound to the account id);
 * - the account's data key encrypts each value (AES-256-GCM, bound to account + item + column, so a ciphertext
 *   cannot be copied to another cell or account).
 * Keys and values are never logged. Without the master key in production every secret action answers 503
 * `secret_master_key_missing`; outside production a fixed development key stands in (never for real data).
 */
export type KeyEnv = Pick<Env, 'SECRET_MASTER_KEY' | 'NODE_ENV'>;

const DEV_MASTER = Buffer.from(
  hkdfSync('sha256', 'bines-dev-only-secret-master-key', 'bines-os', 'secret-master-v1', 32),
);

export const masterKeyOf = (env: KeyEnv): Buffer => {
  if (env.SECRET_MASTER_KEY) {
    const key = parseKey32(env.SECRET_MASTER_KEY);
    if (!key)
      throw new AppError(
        'secret_master_key_missing',
        'SECRET_MASTER_KEY must be 32 bytes (base64 or 64 hex characters)',
      );
    return key;
  }
  if (env.NODE_ENV === 'production')
    throw new AppError('secret_master_key_missing', 'SECRET_MASTER_KEY is not set: secret columns are unavailable');
  return DEV_MASTER;
};

/** Whether secret columns can work here (a startup warning when they cannot; the key itself is never printed). */
export const secretKeyProblem = (env: KeyEnv): string | null => {
  try {
    masterKeyOf(env);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'SECRET_MASTER_KEY problem';
  }
};

const keyAad = (accountId: string) => `secret-key:${accountId}`;
const valueAad = (accountId: string, itemId: string, columnId: string) =>
  `secret-value:${accountId}:${itemId}:${columnId}`;

/** The account's data key (created on first use). */
export const accountDataKey = async (db: Db, env: KeyEnv, accountId: string): Promise<Buffer> => {
  const master = masterKeyOf(env);
  let wrapped = await findWrappedKey(db, accountId);
  if (!wrapped) {
    await insertWrappedKey(db, accountId, gcmSeal(master, randomBytes(32), keyAad(accountId)));
    wrapped = (await findWrappedKey(db, accountId))!;
  }
  try {
    return gcmOpen(master, wrapped, keyAad(accountId));
  } catch {
    throw new AppError('secret_master_key_missing', 'SECRET_MASTER_KEY does not open this account’s data key');
  }
};

export type CellRef = { accountId: string; itemId: string; columnId: string };

export const encryptSecret = (dataKey: Buffer, ref: CellRef, plain: string) =>
  gcmSeal(dataKey, plain, valueAad(ref.accountId, ref.itemId, ref.columnId));

export const decryptSecret = (dataKey: Buffer, ref: CellRef, sealed: string) =>
  gcmOpen(dataKey, sealed, valueAad(ref.accountId, ref.itemId, ref.columnId)).toString('utf8');

/** A secret update's text: bound to the account and the update (never movable to another). */
const updateAad = (accountId: string, updateId: string) => `secret-update:${accountId}:${updateId}`;

export const encryptUpdateBody = (dataKey: Buffer, accountId: string, updateId: string, plain: string) =>
  gcmSeal(dataKey, plain, updateAad(accountId, updateId));

export const decryptUpdateBody = (dataKey: Buffer, accountId: string, updateId: string, sealed: string) =>
  gcmOpen(dataKey, sealed, updateAad(accountId, updateId)).toString('utf8');
