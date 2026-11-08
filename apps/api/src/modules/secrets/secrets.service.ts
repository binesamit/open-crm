// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  canAccount,
  columnTypes,
  deriveValues,
  type SecretLogAction,
  type SecretLogEntry,
  type SecretLogPage,
  secretLogQuerySchema,
  secretMarkerOf,
  type SecretReveal,
  type SecretSettings,
  secretChangeNeedsCode,
  secretSettingsOf,
  secretValueFor,
  type SecretStatus,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AppDeps, RequestMeta, TokenAuth } from '../../types';
import { RateLimiter } from '../../lib/rate-limit';
import { type ActivityRow, recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { twoFactorEnabledOf } from '../admin/two-factor.repo';
import { activeAdminIds } from '../billing/plans.repo';
import { assertBoard, type BoardAccess, columnAllowed } from '../boards/boards.access';
import { type ColumnRow, findColumnById, findColumnByKey, listColumns } from '../boards/boards.repo';
import { type Actor, assertAssigned, freshItem, loadItem } from '../items/items.service';
import { deleteCell, itemCells, updateItemRow, upsertCell } from '../items/items.repo';
import { notifyUsers } from '../notifications/notify';
import { accountDataKey, decryptSecret, encryptSecret } from './secret-crypto';
import { assertFreshCode } from './step-up';
import {
  countActions,
  countSecretLog,
  deleteSecretValue,
  findGrant,
  findSecretValue,
  listColumnSecretValues,
  listSecretLog,
  namesOf,
  putGrant,
  putSecretValue,
} from './secrets.repo';

/**
 * Secret columns. Who may do what
 * - set / clear: whoever may edit the column (board edit rights, the column's edit restriction, edit_assigned); when
 *   the cell already has a value and the column's `change_requires_code` is on (the default), replacing or clearing it
 * also needs the same fresh two-factor code as a reveal ("deleting / replacing a secret — with a
 *   code?"); a value set into an empty cell never does;
 * - reveal / copy: whoever can see the item and the column, has two-factor authentication on and — when the column
 *   lists people — is listed; a person's session needs a fresh code (`POST /secrets/verify`) within the column's
 *   `verify_minutes`; an API token needs the `secrets:read` scope (never implied, never an extension's token);
 *   remote support access never reveals;
 * change the column's settings: `column.update`, and the same fresh code (`step-up.ts`, checked in
 *   `updateColumn`); renaming needs no code.
 * Every action is in the audit log (`secret.*`), the value never is. Many reveals in an hour alert the admins.
 */
export type SecretActor = Actor & { sessionId: string | null; token: TokenAuth | null; meta: RequestMeta };

const HOUR = 3_600_000;
/** Wrong codes: 5 per person per 15 minutes, then 429 (the sign-in has its own limits). */
const codeFailures = new RateLimiter(5, 15 * 60_000);
/** Reveals and copies: 60 a minute per person (a script, not a person, goes faster). */
const revealLimiter = new RateLimiter(60, 60_000);

/** the value to store — a check box column takes "1" / "0" (or words like כן / true), nothing else. */
const checkedValue = (settings: SecretSettings, raw: string, columnKey?: string) => {
  const v = secretValueFor(settings, raw);
  if (v === null)
    throw new AppError('invalid_value', 'A check box secret takes checked / not checked', {
      ...(columnKey ? { column_id: columnKey } : {}),
    });
  return v;
};

const loadSecretCell = async (db: Db, a: Actor, itemId: string, columnKey: string) => {
  const { item, access } = await loadItem(db, a, itemId);
  const column = await findColumnByKey(db, item.boardId, columnKey);
  const def = column ? columnTypes.get(column.type) : undefined;
  if (!column || !def || def.engine !== 'secret' || !columnAllowed(access, column.restrictedView))
    throw new AppError('not_found', 'Secret column not found');
  return { item, access, column, def, settings: secretSettingsOf(column.settings) };
};

export const auditOf = (
  db: Db,
  a: SecretActor,
  action: `secret.${SecretLogAction}`,
  target: {
    itemId?: string;
    boardId?: string;
    columnId?: string;
    columnKey?: string;
    columnTitle?: string;
    itemName?: string;
  },
  extra: Record<string, unknown> = {},
) =>
  recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action,
    targetType: target.itemId ? 'item' : 'user',
    targetId: target.itemId ?? a.user.id,
    payload: {
      ...(target.boardId ? { board_id: target.boardId } : {}),
      ...(target.columnId ? { column_id: target.columnId, column_key: target.columnKey } : {}),
      ...(target.columnTitle ? { column_title: target.columnTitle } : {}),
      ...(target.itemName ? { item_name: target.itemName } : {}),
      via: a.token ? 'token' : 'session',
      ...extra,
    },
    ip: a.meta.ip,
    userAgent: a.meta.userAgent,
  });

// ---- set / clear ----

/** PUT …/secret: encrypts and stores the value (null / empty clears it); the cell keeps only the marker. */
export const setSecret = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  a: SecretActor,
  itemId: string,
  columnKey: string,
  raw: string | null,
) => {
  const { db } = deps;
  const { item, access, column, def, settings } = await loadSecretCell(db, a, itemId, columnKey);
  assertBoard(access, 'item.update');
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
  if (column.convertingId) throw new AppError('column_converting', `Column "${column.key}" is being converted`);
  const cells = await itemCells(db, item.id);
  assertAssigned(access, a.user, item, cells, await listColumns(db, item.boardId));

  // Remote support never writes a secret — not into an empty cell either (audit 2026-10-10 security #16).
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  const value = raw === null || raw === '' ? null : checkedValue(settings, raw);
  const had = cells.some((c) => c.columnId === column.id) || !!(await findSecretValue(db, item.id, column.id));
  // Replacing or clearing a value (or any change of a check box): the column may ask for a fresh code first.
  if (secretChangeNeedsCode(settings, had)) await assertFreshCode(db, a, settings);
  const ref = { accountId: a.ctx.accountId, itemId: item.id, columnId: column.id };
  // Encrypt before the transaction (a missing master key fails here, nothing written).
  const sealed = value === null ? null : encryptSecret(await accountDataKey(db, deps.env, a.ctx.accountId), ref, value);
  const now = new Date();
  const eventId = await db.transaction(async (tx) => {
    if (sealed === null) {
      await deleteSecretValue(tx, item.id, column.id);
      await deleteCell(tx, item.id, column.id);
    } else {
      await putSecretValue(tx, { ...ref, boardId: item.boardId, ciphertext: sealed, updatedBy: a.user.id });
      const marker = secretMarkerOf(settings, value!, a.user.id, now);
      const d = deriveValues(def, column.settings, marker);
      await upsertCell(tx, {
        itemId: item.id,
        columnId: column.id,
        accountId: a.ctx.accountId,
        boardId: item.boardId,
        value: marker,
        textValue: d.textValue,
        numberValue: d.numberValue,
        dateValue: null,
        dateEndValue: null,
        updatedBy: a.user.id,
        updatedByType: 'user',
      });
    }
    await updateItemRow(tx, item.id, { lastCellChangeAt: now, lastCellChangeBy: a.user.id });
    // "Changed" only: no value before or after, ever (activity, webhooks, undo read this row).
    const id = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'secret.changed',
      actorId: a.user.id,
      actorType: a.token ? 'api' : 'user',
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      meta: { column_key: column.key, column_type: column.type, action: sealed === null ? 'cleared' : 'set', had },
    });
    await auditOf(
      tx,
      a,
      sealed === null ? 'secret.cleared' : 'secret.set',
      {
        itemId: item.id,
        boardId: item.boardId,
        columnId: column.id,
        columnKey: column.key,
        columnTitle: column.title,
        itemName: item.name,
      },
      // Whether a value was there before, and whether the change went through the two-factor step-up.
      { replaced: had, step_up: had && settings.change_requires_code },
    );
    return id;
  });
  // Not undoable (the old value is never kept) — no event id for Ctrl+Z.
  void eventId;
  return { ...(await freshItem(db, a, access, item.id)), event_id: null };
};

// --- many at once: "ייבוא ועריכה" ----

/**
 * Before a batch writes any secret: never remote support, and only a person's session or an API token — the AI
 * assistant, agents, MCP and automations (neither) never write secrets.
 */
export const assertMayWriteSecretsInBatch = (a: SecretActor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  if (!a.sessionId && !a.token) throw new AppError('forbidden', 'secret_not_for_ai');
};

export type BatchSecretResult = 'set' | 'replaced' | 'skipped';

/**
 * One secret cell of a bulk edit / file import, inside the batch's transaction: the rules of `setSecret` (the column
 * may be edited by the actor; a cell with a value is replaced only with `replace` — and, with the column's
 * `change_requires_code`, a fresh code, checked once per column through `verified`), the same encryption, the
 * marker cell, a `secret.changed` event (with the batch id; never a value) and the `secret.set` audit. The item's
 * own rights (edit_assigned) are the caller's (the bulk edit checks them per row). A value set into an empty cell
 * is undone with the batch (cleared); a replaced one can not be (the old value is never kept).
 */
export const writeSecretInBatch = async (
  tx: Db,
  a: SecretActor,
  dataKey: Buffer,
  access: BoardAccess,
  item: { id: string; boardId: string; name: string },
  column: ColumnRow,
  value: string,
  /** `via`: where the value came from when not a bulk edit / import (a form's answer). */
  /** `fresh`: the item was made by this same request (a new row, a form's new item). */
  opts: { batchId: string; replace: boolean; verified: Set<string>; via?: Record<string, unknown>; fresh?: boolean },
): Promise<BatchSecretResult> => {
  const def = columnTypes.get(column.type);
  if (def?.engine !== 'secret') throw new AppError('invalid_value', 'Not a secret column', { column_id: column.key });
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
  if (column.convertingId) throw new AppError('column_converting', `Column "${column.key}" is being converted`);
  const settings = secretSettingsOf(column.settings);
  const had =
    (await itemCells(tx, item.id)).some((c) => c.columnId === column.id) ||
    !!(await findSecretValue(tx, item.id, column.id));
  if (had && !opts.replace) return 'skipped';
  // An item this request just made (an imported row, a form's answer) starts with the value: setting
  // it changes nothing anyone saw, so a check box there needs no code either (is about existing items).
  const stepUp = opts.fresh ? had && settings.change_requires_code : secretChangeNeedsCode(settings, had);
  if (stepUp && !opts.verified.has(column.id)) {
    await assertFreshCode(tx, a, settings);
    opts.verified.add(column.id);
  }
  const ref = { accountId: a.ctx.accountId, itemId: item.id, columnId: column.id };
  const now = new Date();
  const stored = checkedValue(settings, value, column.key);
  await putSecretValue(tx, {
    ...ref,
    boardId: item.boardId,
    ciphertext: encryptSecret(dataKey, ref, stored),
    updatedBy: a.user.id,
  });
  const marker = secretMarkerOf(settings, stored, a.user.id, now);
  const d = deriveValues(def, column.settings, marker);
  await upsertCell(tx, {
    itemId: item.id,
    columnId: column.id,
    accountId: a.ctx.accountId,
    boardId: item.boardId,
    value: marker,
    textValue: d.textValue,
    numberValue: d.numberValue,
    dateValue: null,
    dateEndValue: null,
    updatedBy: a.user.id,
    updatedByType: 'user',
  });
  await updateItemRow(tx, item.id, { lastCellChangeAt: now, lastCellChangeBy: a.user.id });
  await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'secret.changed',
    actorId: a.user.id,
    actorType: a.token ? 'api' : 'user',
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: item.id,
    columnId: column.id,
    batchId: opts.batchId,
    meta: {
      column_key: column.key,
      column_type: column.type,
      action: 'set',
      had,
      ...(opts.via ? { via: opts.via } : { bulk: true }),
    },
  });
  await auditOf(
    tx,
    a,
    'secret.set',
    {
      itemId: item.id,
      boardId: item.boardId,
      columnId: column.id,
      columnKey: column.key,
      columnTitle: column.title,
      itemName: item.name,
    },
    { replaced: had, step_up: stepUp, ...(opts.via ? opts.via : { bulk: true }) },
  );
  return had ? 'replaced' : 'set';
};

/** The undo of a batch's secret set into an empty cell: it is cleared again (a value changed since: `changed`). */
export const bulkSecretChanged = async (tx: Db, ev: ActivityRow) => {
  const v = ev.itemId && ev.columnId ? await findSecretValue(tx, ev.itemId, ev.columnId) : undefined;
  return !!v && v.updatedAt.getTime() - ev.createdAt.getTime() > 1000;
};

export const undoBulkSecretTx = async (tx: Db, a: Actor, ev: ActivityRow) => {
  const column = ev.columnId ? await findColumnById(tx, ev.columnId) : undefined;
  if (!column || !ev.itemId) throw new AppError('already_undone', 'Column not found');
  const { item, access } = await loadItem(tx, a, ev.itemId);
  assertBoard(access, 'item.update');
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
  await deleteSecretValue(tx, item.id, column.id);
  await deleteCell(tx, item.id, column.id);
  const id = await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'secret.changed',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: item.id,
    columnId: column.id,
    meta: {
      column_key: column.key,
      column_type: column.type,
      action: 'cleared',
      had: true,
      undo_of: ev.id,
    },
  });
  await recordAudit(tx, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'secret.cleared',
    targetType: 'item',
    targetId: item.id,
    payload: {
      board_id: item.boardId,
      column_id: column.id,
      column_key: column.key,
      column_title: column.title,
      item_name: item.name,
      via: 'undo',
    },
  });
  return id;
};

// ---- the two-factor step-up ----

const sessionOnly = (a: SecretActor) => {
  if (!a.sessionId || a.token) throw new AppError('forbidden', 'session_only');
  return a.sessionId;
};

export const secretStatus = async (db: Db, a: SecretActor): Promise<SecretStatus> => {
  const sessionId = sessionOnly(a);
  const grant = await findGrant(db, a.user.id, sessionId);
  return {
    two_factor_enabled: await twoFactorEnabledOf(db, a.user.id),
    verified_at: grant?.verifiedAt.toISOString() ?? null,
  };
};

/**
 * POST /secrets/verify: a fresh code from the person's authenticator app (the same check as the sign-in step,
 * Better Auth's verify-totp, on this session) → a reveal grant for this session.
 */
export const verifyForSecrets = async (
  deps: Pick<AppDeps, 'db' | 'auth'>,
  a: SecretActor,
  code: string,
  headers: Headers,
): Promise<SecretStatus> => {
  const { db } = deps;
  const sessionId = sessionOnly(a);
  if (!(await twoFactorEnabledOf(db, a.user.id))) throw new AppError('secret_two_factor_required');
  const wait = codeFailures.peek(a.user.id);
  if (wait) throw new AppError('rate_limited', 'Too many wrong codes', { retry_after: Math.ceil(wait / 1000) });
  let ok = false;
  try {
    await deps.auth.api.verifyTOTP({ body: { code }, headers });
    ok = true;
  } catch {
    ok = false;
  }
  if (!ok) {
    codeFailures.hit(a.user.id);
    await auditOf(db, a, 'secret.verify_failed', {});
    throw new AppError('secret_code_invalid');
  }
  const now = new Date();
  await putGrant(db, a.user.id, sessionId, now);
  await auditOf(db, a, 'secret.verify', {});
  return { two_factor_enabled: true, verified_at: now.toISOString() };
};

// ---- reveal / copy ----

/** The checks of a reveal or a copy (the permission matrix). */
export const assertMayReveal = async (db: Db, a: SecretActor, settings: SecretSettings) => {
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  if (settings.reveal_mode === 'people' && !settings.reveal_user_ids.includes(a.user.id))
    throw new AppError('forbidden', 'secret_reveal_not_allowed');
  await assertFreshCode(db, a, settings);
};

export const limitReveals = (a: SecretActor) => {
  const wait = revealLimiter.hit(a.user.id);
  if (wait) throw new AppError('rate_limited', 'Too many reveals', { retry_after: Math.ceil(wait / 1000) });
};

/**
 * More reveals by one person in the last hour than the column's threshold → one alert to the account's admins
 * (at most one an hour per person). 0 = no alert.
 */
export const alertIfMany = async (db: Db, a: SecretActor, settings: SecretSettings) => {
  if (!settings.alert_threshold) return;
  const since = new Date(Date.now() - HOUR);
  const reveals = await countActions(db, a.ctx.accountId, a.user.id, 'secret.reveal', since);
  if (reveals <= settings.alert_threshold) return;
  if (await countActions(db, a.ctx.accountId, a.user.id, 'secret.alert', since)) return;
  await auditOf(db, a, 'secret.alert', {}, { count: reveals, threshold: settings.alert_threshold });
  const admins = await activeAdminIds(db, a.ctx.accountId);
  // Required (security): the admins cannot switch it off.
  await notifyUsers(
    db,
    {
      accountId: a.ctx.accountId,
      type: 'secret_reveals',
      actorId: a.user.id,
      payload: {
        count: reveals,
        threshold: settings.alert_threshold,
        excerpt: `${a.user.name || a.user.email} · ${reveals} / ${settings.alert_threshold}`,
      },
    },
    admins,
  );
};

/** POST …/secret/reveal: the value, once (no caching — the route says so), audited. */
export const revealSecret = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  a: SecretActor,
  itemId: string,
  columnKey: string,
): Promise<SecretReveal> => {
  const { db } = deps;
  const { item, column, settings } = await loadSecretCell(db, a, itemId, columnKey);
  await assertMayReveal(db, a, settings);
  limitReveals(a);
  const row = await findSecretValue(db, item.id, column.id);
  if (!row) throw new AppError('not_found', 'secret_empty');
  const ref = { accountId: a.ctx.accountId, itemId: item.id, columnId: column.id };
  const value = decryptSecret(await accountDataKey(db, deps.env, a.ctx.accountId), ref, row.ciphertext);
  await auditOf(db, a, 'secret.reveal', {
    itemId: item.id,
    boardId: item.boardId,
    columnId: column.id,
    columnKey: column.key,
    columnTitle: column.title,
    itemName: item.name,
  });
  await alertIfMany(db, a, settings);
  // A check box has nothing to copy.
  return {
    value,
    reveal_seconds: settings.reveal_seconds,
    copy_allowed: settings.copy_allowed && settings.kind !== 'checkbox',
  };
};

/** POST …/secret/copy: the app copied a revealed value to the clipboard — audited (refused when copy is off). */
export const recordSecretCopy = async (db: Db, a: SecretActor, itemId: string, columnKey: string) => {
  const { item, column, settings } = await loadSecretCell(db, a, itemId, columnKey);
  await assertMayReveal(db, a, settings);
  if (!settings.copy_allowed || settings.kind === 'checkbox')
    throw new AppError('forbidden', 'secret_copy_not_allowed');
  limitReveals(a);
  await auditOf(db, a, 'secret.copy', {
    itemId: item.id,
    boardId: item.boardId,
    columnId: column.id,
    columnKey: column.key,
    columnTitle: column.title,
    itemName: item.name,
  });
  return { ok: true as const };
};

// ---- the admins' log ----

const DAY = 86_400_000;

/** GET /secrets/log: who revealed / copied / changed which secret and when (Administration → Security). */
export const secretLog = async (
  db: Db,
  a: Pick<Actor, 'ctx'>,
  raw: z.input<typeof secretLogQuerySchema>,
): Promise<SecretLogPage> => {
  const decision = canAccount(a.ctx.role, 'audit.read');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  const q = secretLogQuerySchema.parse(raw);
  const f = {
    actorId: q.actor_id || undefined,
    boardId: q.board_id || undefined,
    action: q.action,
    from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined,
    to: q.to ? new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + DAY) : undefined,
  };
  const [rows, total] = await Promise.all([
    listSecretLog(db, a.ctx.accountId, f, q.page_size, (q.page - 1) * q.page_size),
    countSecretLog(db, a.ctx.accountId, f),
  ]);
  const p = (r: (typeof rows)[number]) => (r.row.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const boardIds = [...new Set(rows.map((r) => str(p(r).board_id)).filter((x): x is string => !!x))];
  const itemIds = [
    ...new Set(rows.filter((r) => r.row.targetType === 'item' && r.row.targetId).map((r) => r.row.targetId!)),
  ];
  const names = await namesOf(db, a.ctx.accountId, boardIds, itemIds);
  const data: SecretLogEntry[] = rows.map((r) => {
    const payload = p(r);
    const boardId = str(payload.board_id);
    const itemId = r.row.targetType === 'item' ? r.row.targetId : null;
    return {
      id: r.row.id,
      created_at: r.row.createdAt.toISOString(),
      action: r.row.action.replace(/^secret\./, '') as SecretLogAction,
      actor_id: r.row.actorId,
      actor_name: r.actorName ?? null,
      board_id: boardId,
      board_name: (boardId ? names.boards.get(boardId) : undefined) ?? null,
      item_id: itemId,
      item_name: (itemId ? names.items.get(itemId) : undefined) ?? str(payload.item_name),
      column_title: str(payload.column_title),
      update_id: str(payload.update_id),
      via_token: payload.via === 'token',
      ip: r.row.ip,
    };
  });
  return { data, total, page: q.page, page_size: q.page_size };
};

// --- a check box column's markers ----

/**
 * After a check box column's `checkbox_visible` changed: every cell's marker says whether it is checked (shown) or no
 * longer does (hidden) — the values are read with the account's key, never leave the server. Text columns: nothing.
 */
export const syncSecretMarkers = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  accountId: string,
  column: { id: string; boardId: string; settings: unknown },
) => {
  const settings = secretSettingsOf(column.settings);
  const rows = await listColumnSecretValues(deps.db, column.id);
  if (!rows.length) return;
  const dataKey = await accountDataKey(deps.db, deps.env, accountId);
  const def = columnTypes.get('secret')!;
  await deps.db.transaction(async (tx) => {
    for (const r of rows) {
      const value =
        settings.kind === 'checkbox' && settings.checkbox_visible
          ? decryptSecret(dataKey, { accountId, itemId: r.itemId, columnId: column.id }, r.ciphertext)
          : '';
      const marker = { ...secretMarkerOf(settings, value, r.updatedBy, r.updatedAt) };
      const d = deriveValues(def, settings, marker);
      await upsertCell(tx, {
        itemId: r.itemId,
        columnId: column.id,
        accountId,
        boardId: column.boardId,
        value: marker,
        textValue: d.textValue,
        numberValue: d.numberValue,
        dateValue: null,
        dateEndValue: null,
        updatedBy: r.updatedBy,
        updatedByType: 'user',
      });
    }
  });
};

/** Whether a secret column holds any value (its kind is fixed then). */
export const secretColumnHasValues = async (db: Db, columnId: string) =>
  (await listColumnSecretValues(db, columnId, 1)).length > 0;
