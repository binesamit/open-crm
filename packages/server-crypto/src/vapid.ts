// SPDX-License-Identifier: AGPL-3.0-only
import { gcmOpen, gcmSeal, parseKey32 } from './gcm';

/**
 * The generated Web Push (VAPID) pair kept in platform_settings row `vapid` (PWA פ4), at rest. The API writes it,
 * the worker reads it — both through these two functions, so the format lives in one place.
 *
 * - With `SECRET_MASTER_KEY` (32 bytes, the same variable as the secret columns): the private key is stored sealed
 *   (`private_key_enc`, AES-256-GCM bound to this row), the public key stays readable.
 * - Without it: stored as before (`private_key` in plain) — nothing breaks where the variable is not set.
 * - Old rows in plain are still read; the API re-seals them the first time it reads them with a key.
 */
export type VapidRow = { public_key?: string; private_key?: string; private_key_enc?: string };
export type StoredVapid = { publicKey: string; privateKey: string };

export type VapidRead =
  /** No pair yet. */
  | { state: 'none' }
  /** `plain` = stored unencrypted (seal it when a key is available). */
  | { state: 'ok'; pair: StoredVapid; plain: boolean }
  /** Sealed, and this process has no (or another) master key: only the public key is known. */
  | { state: 'locked'; publicKey: string };

const AAD = 'platform-secret:vapid:private_key';

/** SECRET_MASTER_KEY as a key; null when it is unset or not 32 bytes (then the pair is kept as before). */
export const platformMasterKey = (value: string | null | undefined): Buffer | null =>
  value ? parseKey32(value) : null;

export const readVapidRow = (row: VapidRow | null | undefined, master: Buffer | null): VapidRead => {
  const publicKey = row?.public_key;
  if (!publicKey) return { state: 'none' };
  if (row.private_key_enc) {
    if (!master) return { state: 'locked', publicKey };
    try {
      return {
        state: 'ok',
        pair: { publicKey, privateKey: gcmOpen(master, row.private_key_enc, AAD).toString('utf8') },
        plain: false,
      };
    } catch {
      return { state: 'locked', publicKey };
    }
  }
  return row.private_key
    ? { state: 'ok', pair: { publicKey, privateKey: row.private_key }, plain: true }
    : { state: 'none' };
};

/** The row to store for `pair`: sealed with the master key when there is one, else as before. */
export const vapidRowFor = (pair: StoredVapid, master: Buffer | null): VapidRow =>
  master
    ? { public_key: pair.publicKey, private_key_enc: gcmSeal(master, pair.privateKey, AAD) }
    : { public_key: pair.publicKey, private_key: pair.privateKey };
