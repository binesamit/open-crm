// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BoardSecretUpdates,
  displayUpdateHtml,
  type SecretSettings,
  type SecretUpdateReveal,
  type SecretUpdateSettings,
  secretUpdateSettingsOf,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor, RequestMeta, TokenAuth } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { twoFactorEnabledOf } from '../admin/two-factor.repo';
import { isOwnerOrAdmin, loadBoardAccess } from '../boards/boards.access';
import { findBoard, updateBoardRow } from '../boards/boards.repo';
import { loadItem } from '../items/items.service';
import { findUpdate } from '../updates/updates.repo';
import { accountDataKey, decryptUpdateBody, encryptUpdateBody, type KeyEnv } from './secret-crypto';
import { alertIfMany, assertMayReveal, auditOf, limitReveals, type SecretActor } from './secrets.service';
import { findUpdateBody } from './secrets.repo';
import { assertFreshCode } from './step-up';

/**
 * Secret updates: an update or reply whose text is encrypted like a secret column's value, with the
 * same engine — the account's data key, the two-factor step-up and its grant, the `secret.*` audit and the admins'
 * alert. Who may do what:
 * - write one: whoever may comment on the item, with 2FA on (else they could not read it back), where the board's
 *   settings allow it; never remote support, never guests; a reply in a secret thread is always secret;
 * - reveal / copy: whoever sees the item (not guests), with 2FA, a fresh code within the settings' minutes and — when
 *   the settings list people — listed; an API token needs `secrets:read`; AI, agents, MCP and automations never;
 * - edit (the author) / delete (the author, board owners, admins): with a fresh code when the settings ask for one;
 * - change the settings: account admins (the account's default) or board owners and admins (a board's override),
 *   always with a fresh code (they guard the text).
 * Nothing here ever logs or audits the text.
 */

/** What a request needs to encrypt a secret update and to pass its step-up (REST only; AI / agents have none). */
export type SecretWriter = { env: KeyEnv; meta: RequestMeta; sessionId: string | null; token: TokenAuth | null };

/** The stored text of a secret update: what the plain update row would have held. */
export type SecretBody = { html: string; text: string; json: Record<string, unknown> | null };

/** The column-shaped settings the shared step-up / reveal checks read (secret updates are one text). */
export const asSecretSettings = (s: SecretUpdateSettings): SecretSettings => ({
  ...s,
  multiline: false,
  kind: 'text',
  checkbox_visible: false,
});

const overrideOf = (settings: unknown): SecretUpdateSettings | null => {
  const raw = (settings as { secret_updates?: unknown } | null)?.secret_updates;
  return raw && typeof raw === 'object' ? secretUpdateSettingsOf(raw) : null;
};

const accountDefaultOf = async (db: Db, accountId: string) =>
  secretUpdateSettingsOf(((await getAccountSettings(db, accountId)) as { secret_updates?: unknown }).secret_updates);

/** The board whose settings count: a subitems board follows its parent board. */
const topBoardOf = async (db: Db, accountId: string, boardId: string) => {
  const board = await findBoard(db, accountId, boardId);
  if (!board) throw new AppError('not_found', 'Board not found');
  return board.parentBoardId ? ((await findBoard(db, accountId, board.parentBoardId)) ?? board) : board;
};

/** What counts on a board: its own override, else the account's default. */
export const secretUpdateSettingsFor = async (db: Db, accountId: string, boardId: string) => {
  const top = await topBoardOf(db, accountId, boardId);
  const account = await accountDefaultOf(db, accountId);
  const board = overrideOf(top.settings);
  return { effective: board ?? account, account, board, top };
};

/** May this person write a secret update on this board (before anything is stored)? */
export const assertMayWriteSecret = async (db: Db, a: Actor, settings: SecretUpdateSettings) => {
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'secret_not_for_guests');
  if (!settings.enabled) throw new AppError('forbidden', 'secret_updates_off');
  if (!(await twoFactorEnabledOf(db, a.user.id))) throw new AppError('secret_two_factor_required');
};

/** Encrypts a secret update's text (before the transaction: a missing master key fails here, nothing written). */
export const sealSecretBody = async (env: KeyEnv, db: Db, accountId: string, updateId: string, body: SecretBody) =>
  encryptUpdateBody(await accountDataKey(db, env, accountId), accountId, updateId, JSON.stringify(body));

/** Edit / delete of a secret update: the fresh code when the board's settings ask for it. Support never. */
export const assertMayChangeSecretUpdate = async (
  db: Db,
  a: Actor & { sessionId?: string | null; token?: TokenAuth | null },
  boardId: string,
) => {
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  const { effective } = await secretUpdateSettingsFor(db, a.ctx.accountId, boardId);
  if (effective.change_requires_code) await assertFreshCode(db, a, asSecretSettings(effective));
};

/** A secret update the actor may see (the item's visibility), never for guests. */
const loadSecretUpdate = async (db: Db, a: SecretActor, updateId: string) => {
  const update = await findUpdate(db, a.ctx.accountId, updateId);
  if (!update || !update.isSecret) throw new AppError('not_found', 'Update not found');
  const { item } = await loadItem(db, a, update.itemId);
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'secret_not_for_guests');
  const { effective } = await secretUpdateSettingsFor(db, a.ctx.accountId, update.boardId);
  return { update, item, settings: asSecretSettings(effective) };
};

const auditTarget = (u: { itemId: string; boardId: string }, itemName: string) => ({
  itemId: u.itemId,
  boardId: u.boardId,
  itemName,
});

/** POST /updates/{id}/reveal: the text, once (the route says no-store), audited; the admins' alert as for columns. */
export const revealSecretUpdate = async (
  deps: { db: Db; env: KeyEnv },
  a: SecretActor,
  updateId: string,
): Promise<SecretUpdateReveal> => {
  const { db } = deps;
  const { update, item, settings } = await loadSecretUpdate(db, a, updateId);
  await assertMayReveal(db, a, settings);
  limitReveals(a);
  const row = await findUpdateBody(db, update.id);
  if (!row) throw new AppError('not_found', 'secret_empty');
  const body = JSON.parse(
    decryptUpdateBody(await accountDataKey(db, deps.env, a.ctx.accountId), a.ctx.accountId, update.id, row.ciphertext),
  ) as SecretBody;
  await auditOf(db, a, 'secret.reveal', auditTarget(update, item.name), { update_id: update.id, kind: 'update' });
  await alertIfMany(db, a, settings);
  return {
    body_html: displayUpdateHtml(body.html, body.text),
    body_text: body.text,
    body_json: body.json,
    reveal_seconds: settings.reveal_seconds,
    copy_allowed: settings.copy_allowed,
  };
};

/** POST /updates/{id}/secret-copy: the app copied a revealed text — audited (refused when copying is off). */
export const recordSecretUpdateCopy = async (db: Db, a: SecretActor, updateId: string) => {
  const { update, item, settings } = await loadSecretUpdate(db, a, updateId);
  await assertMayReveal(db, a, settings);
  if (!settings.copy_allowed) throw new AppError('forbidden', 'secret_copy_not_allowed');
  limitReveals(a);
  await auditOf(db, a, 'secret.copy', auditTarget(update, item.name), { update_id: update.id, kind: 'update' });
  return { ok: true as const };
};

// ---- settings ----

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** GET /boards/{id}/secret-updates: anyone who reads the board (the composer needs `enabled`). */
export const getBoardSecretUpdates = async (db: Db, a: Actor, boardId: string): Promise<BoardSecretUpdates> => {
  await loadBoardAccess(db, a.ctx, a.user, boardId);
  const { effective, account, board, top } = await secretUpdateSettingsFor(db, a.ctx.accountId, boardId);
  // A subitems board: managing means owning its parent board.
  const access = await loadBoardAccess(db, a.ctx, a.user, top.id).catch(() => null);
  return { effective, account, board, can_manage: !a.ctx.support && !!access && isOwnerOrAdmin(access) };
};

/** PUT /boards/{id}/secret-updates: the board's override (null = the account's); owners / admins, fresh code. */
export const putBoardSecretUpdates = async (
  db: Db,
  a: SecretActor,
  boardId: string,
  next: SecretUpdateSettings | null,
): Promise<BoardSecretUpdates> => {
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  const { effective, board, top } = await secretUpdateSettingsFor(db, a.ctx.accountId, boardId);
  const access = await loadBoardAccess(db, a.ctx, a.user, top.id);
  if (!isOwnerOrAdmin(access)) throw new AppError('forbidden', 'board_owner_only');
  const value = next ? secretUpdateSettingsOf(next) : null;
  if (same(board, value)) return getBoardSecretUpdates(db, a, boardId);
  // The settings that count now guard the change (a new, shorter time never shortens its own check).
  await assertFreshCode(db, a, asSecretSettings(effective));
  const settings = { ...((top.settings as Record<string, unknown> | null) ?? {}) };
  if (value) settings.secret_updates = value;
  else delete settings.secret_updates;
  await db.transaction(async (tx) => {
    await updateBoardRow(tx, top.id, { settings });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: top.id,
      before: { secret_updates: board },
      after: { secret_updates: value },
    });
    await auditOf(tx, a, 'secret.settings', { boardId: top.id }, { scope: 'board', kind: 'update' });
  });
  return getBoardSecretUpdates(db, a, boardId);
};

/** GET /secrets/update-settings (admins): the account's default. */
export const getAccountSecretUpdates = async (db: Db, a: Actor) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  return { settings: await accountDefaultOf(db, a.ctx.accountId) };
};

/** PUT /secrets/update-settings (admins, fresh code): the account's default. */
export const putAccountSecretUpdates = async (db: Db, a: SecretActor, next: SecretUpdateSettings) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  const raw = (await getAccountSettings(db, a.ctx.accountId)) as Record<string, unknown>;
  const current = secretUpdateSettingsOf(raw.secret_updates);
  const value = secretUpdateSettingsOf(next);
  if (same(current, value)) return { settings: current };
  await assertFreshCode(db, a, asSecretSettings(current));
  await db.transaction(async (tx) => {
    await upsertAccountSettings(tx, a.ctx.accountId, { ...raw, secret_updates: value }, a.user.id);
    await auditOf(tx, a, 'secret.settings', {}, { scope: 'account', kind: 'update' });
  });
  return { settings: value };
};
