// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  EXT_STORAGE_KEY_RE,
  EXT_STORAGE_MAX_KEYS,
  EXT_STORAGE_QUOTA_BYTES,
  EXT_STORAGE_VALUE_MAX_BYTES,
  EXT_UPLOAD_MAX_BYTES,
  type ExtStorageScope,
  newId,
} from '@bines/shared';
import { sql } from 'drizzle-orm';
import type { AccountContext, AppDeps, SessionUser, TokenAuth } from '../../types';
import { RateLimiter } from '../../lib/rate-limit';
import { insertAsset, markUploaded } from '../files/files.repo';
import { fileDto, safeName } from '../files/files.service';
import {
  deleteStorage,
  findStorage,
  insertStorage,
  listStorage,
  storageUsage,
  updateStorageValue,
} from './extensions.repo';

/**
 * An extension's own storage and uploads (D27 ת5) — reachable only with an extension token, keyed by the token's
 * installation (never another's), and per user for `user` scope. `installation` scope is shared by every user of
 * the extension in the account: guests and viewers may read it but not change it. One quota per installation.
 */
type Deps = Pick<AppDeps, 'db' | 'storage'>;
export type ExtActor = { ctx: AccountContext; user: SessionUser; token: TokenAuth | null };

const extOf = (a: ExtActor) => {
  const ext = a.token?.ext;
  if (!ext) throw new AppError('forbidden', 'extension_token_only');
  return ext;
};

const ownerOf = (a: ExtActor, scope: ExtStorageScope) => (scope === 'user' ? a.user.id : null);

const checkKey = (key: string) => {
  if (!EXT_STORAGE_KEY_RE.test(key)) throw new AppError('invalid_value', 'storage_key_invalid');
};

export const listExtStorage = async (deps: Deps, a: ExtActor, scope: ExtStorageScope, prefix = '') => {
  const ext = extOf(a);
  const [rows, usage] = await Promise.all([
    listStorage(deps.db, ext.installationId, ownerOf(a, scope), prefix),
    storageUsage(deps.db, ext.installationId),
  ]);
  return {
    data: rows.map((r) => ({ key: r.key, size: r.size, updated_at: r.updatedAt.toISOString() })),
    used_bytes: usage.bytes,
    quota_bytes: EXT_STORAGE_QUOTA_BYTES,
  };
};

export const getExtStorage = async (deps: Deps, a: ExtActor, scope: ExtStorageScope, key: string) => {
  const ext = extOf(a);
  checkKey(key);
  const row = await findStorage(deps.db, ext.installationId, ownerOf(a, scope), key);
  if (!row) throw new AppError('not_found', 'Key not found');
  return { key: row.key, value: row.value, size: row.size, updated_at: row.updatedAt.toISOString() };
};

const mayWriteShared = (ctx: AccountContext) => ctx.role !== 'guest' && ctx.role !== 'viewer';

export const putExtStorage = async (deps: Deps, a: ExtActor, scope: ExtStorageScope, key: string, value: unknown) => {
  const ext = extOf(a);
  checkKey(key);
  if (scope === 'installation' && !mayWriteShared(a.ctx)) throw new AppError('forbidden', 'storage_read_only');
  if (value === undefined) throw new AppError('invalid_value', 'storage_value_required');
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > EXT_STORAGE_VALUE_MAX_BYTES)
    throw new AppError('payload_too_large', 'storage_value_too_large', { max_bytes: EXT_STORAGE_VALUE_MAX_BYTES });
  const owner = ownerOf(a, scope);
  // EXT-RT15: count + write under one lock per installation — parallel writes cannot each pass the quota (or add the
  // same key twice).
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ext-storage:${ext.installationId}`}))`);
    const existing = await findStorage(tx, ext.installationId, owner, key);
    const usage = await storageUsage(tx, ext.installationId);
    if (usage.bytes - (existing?.size ?? 0) + size > EXT_STORAGE_QUOTA_BYTES)
      throw new AppError('payload_too_large', 'storage_quota_exceeded', {
        quota_bytes: EXT_STORAGE_QUOTA_BYTES,
        used_bytes: usage.bytes,
      });
    if (!existing && usage.keys >= EXT_STORAGE_MAX_KEYS)
      throw new AppError('payload_too_large', 'storage_quota_exceeded', { max_keys: EXT_STORAGE_MAX_KEYS });
    if (existing) await updateStorageValue(tx, existing.id, value, size);
    else
      await insertStorage(tx, {
        id: newId(),
        accountId: a.ctx.accountId,
        installationId: ext.installationId,
        userId: owner,
        key,
        value: value as never,
        size,
      });
    return {
      key,
      size,
      used_bytes: usage.bytes - (existing?.size ?? 0) + size,
      quota_bytes: EXT_STORAGE_QUOTA_BYTES,
    };
  });
};

export const deleteExtStorage = async (deps: Deps, a: ExtActor, scope: ExtStorageScope, key: string) => {
  const ext = extOf(a);
  checkKey(key);
  if (scope === 'installation' && !mayWriteShared(a.ctx)) throw new AppError('forbidden', 'storage_read_only');
  const gone = await deleteStorage(deps.db, ext.installationId, ownerOf(a, scope), key);
  if (!gone.length) throw new AppError('not_found', 'Key not found');
  return { ok: true as const };
};

/** Uploads per installation per minute. */
const uploads = new RateLimiter(30, 60_000);

/**
 * POST /ext/files — `files.upload` of the SDK: the bytes (≤ 4 MB) become an asset of the user (the same assets an
 * upload in the app makes); the extension then attaches it to a file cell with `POST /items/:id/cells/:col/files`,
 * which checks the board, the column and the user's rights like any attach ("via app X" in the log).
 */
export const uploadExtFile = async (
  deps: Deps,
  a: ExtActor,
  input: { name: string; mime: string; body: ArrayBuffer },
) => {
  const ext = extOf(a);
  if (a.ctx.role === 'viewer' || a.ctx.role === 'guest') throw new AppError('forbidden', 'viewer_read_only');
  const bytes = Buffer.from(input.body);
  if (!bytes.length) throw new AppError('invalid_value', 'file_empty');
  if (bytes.length > EXT_UPLOAD_MAX_BYTES)
    throw new AppError('payload_too_large', 'file_too_large', { max_bytes: EXT_UPLOAD_MAX_BYTES });
  const wait = uploads.hit(ext.installationId);
  if (wait > 0) throw new AppError('rate_limited', 'Too many uploads from this extension', { retry_after_ms: wait });
  const name = input.name.trim().slice(0, 255) || 'file';
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(input.mime) ? input.mime.toLowerCase() : 'application/octet-stream';
  const id = newId();
  const key = `${a.ctx.accountId}/${id}/${safeName(name)}`;
  await insertAsset(deps.db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName: name,
    mime,
    size: bytes.length,
    uploadStatus: 'pending',
  });
  await deps.storage.put(key, bytes, mime);
  await markUploaded(deps.db, id, bytes.length, mime);
  return fileDto({ id, fileName: name, size: bytes.length, mime } as Parameters<typeof fileDto>[0]);
};
