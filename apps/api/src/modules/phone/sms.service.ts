// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  accountSettingsSchema,
  columnTypes,
  newId,
  phoneColumnConfig,
  phoneInfoOf,
  renderTemplate,
  renderUpdateBody,
  SMS_MAX_LENGTH,
  smsSegments,
  type AccountRole,
  type AccountSettings,
  type SendItemSms,
  type SendItemSmsResult,
  type SmsDeniedReason,
  type SmsStatus,
  type TemplateLookup,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { SMS_SENDER_NOT_CONFIGURED } from '../../lib/sms';
import type { AppDeps } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { actorRegion } from '../accounts/region';
import { recordEvent } from '../activity/activity.repo';
import { findBoard, findGroup, type ColumnRow } from '../boards/boards.repo';
import { buildLookup } from '../automations/engine/vars';
import { itemCells, memberNames, type ItemRow } from '../items/items.repo';
import { calculatorFor, itemDto, loadItem, visibleColumns, type Actor } from '../items/items.service';
import { smsSenderId } from '../platform/platform-settings';
import { listUpdates } from '../updates/updates.service';
import { insertUpdate } from '../updates/updates.repo';
import { countSms } from './phone.repo';
import { webOrigin } from '../platform/public-address';

/**
 * SMS from items: `POST /items/{id}/sms` and the automation action `send_sms`. The provider is the
 * environment's `SmsSender` (TextMe today) with the account's sender id; who may send, the templates and the
 * budgets are account settings (`settings.sms`). Every SMS sent is logged as an update on the item (source `sms`).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const loadAccountSettings = async (db: Db, accountId: string): Promise<AccountSettings> =>
  accountSettingsSchema.parse(await getAccountSettings(db, accountId));

/** May a member with this role send SMS under the account's policy? Guests never. */
export const smsDenied = (settings: AccountSettings, role: AccountRole): SmsDeniedReason | null => {
  if (role === 'guest') return 'guest';
  const policy = settings.sms.send_policy;
  if (policy === 'nobody') return 'disabled';
  if (policy === 'admins' && role !== 'admin') return 'admins_only';
  if (policy === 'members' && role !== 'admin' && role !== 'member') return 'members_only';
  return null;
};

const assertMaySend = (settings: AccountSettings, role: AccountRole) => {
  const reason = smsDenied(settings, role);
  if (reason) throw new AppError('forbidden', `sms_${reason}`, { reason });
};

/** Provider keys in this environment and a sender id somewhere (account → platform → TEXTME_SENDER_ID). */
const providerReady = async (deps: Pick<AppDeps, 'db' | 'env' | 'sms'>, accountId: string) =>
  deps.sms.configured !== false && !!((await smsSenderId(deps.db, accountId)) || deps.env.TEXTME_SENDER_ID);

/** GET /sms/status */
export const smsStatus = async (deps: Pick<AppDeps, 'db' | 'env' | 'sms'>, a: Actor): Promise<SmsStatus> => {
  const settings = await loadAccountSettings(deps.db, a.ctx.accountId);
  const ready = await providerReady(deps, a.ctx.accountId);
  const denied = smsDenied(settings, a.ctx.role) ?? (ready ? null : 'not_configured');
  const guest = a.ctx.role === 'guest';
  const now = Date.now();
  return {
    can_send: !denied,
    reason: denied,
    provider_ready: ready,
    send_policy: settings.sms.send_policy,
    // Guests never send: they get no templates either.
    templates: guest ? [] : settings.sms.templates,
    limits: settings.sms.limits,
    usage: {
      user_last_hour: guest ? 0 : await countSms(deps.db, a.ctx.accountId, new Date(now - HOUR), a.user.id),
      account_last_day: guest ? 0 : await countSms(deps.db, a.ctx.accountId, new Date(now - DAY)),
    },
    max_length: SMS_MAX_LENGTH,
    account_country: settings.locale.country,
  };
};

/**
 * The E.164 number of the cell, checked against what the provider can deliver to — `sms_unsupported_number` with
 * `details.reason` (empty / invalid / unsupported_destination) otherwise.
 */
export const smsRecipient = (
  deps: Pick<AppDeps, 'sms'>,
  column: Pick<ColumnRow, 'key' | 'settings'>,
  value: unknown,
  accountCountry: string,
): string => {
  const phone = (value as { phone?: unknown } | null)?.phone;
  if (typeof phone !== 'string' || !phone.trim())
    throw new AppError('sms_unsupported_number', 'The phone cell is empty', { reason: 'empty', column_id: column.key });
  const info = phoneInfoOf(value, phoneColumnConfig(column.settings).defaultCountry, accountCountry);
  if (!info.valid || !info.e164)
    throw new AppError('sms_unsupported_number', 'Not a valid phone number', {
      reason: 'invalid',
      column_id: column.key,
    });
  if (deps.sms.accepts && !deps.sms.accepts(info.e164))
    throw new AppError('sms_unsupported_number', 'The SMS provider cannot send to this number', {
      reason: 'unsupported_destination',
      column_id: column.key,
      e164: info.e164,
    });
  return info.e164;
};

const assertBudget = async (db: Db, accountId: string, settings: AccountSettings, userId: string | null) => {
  const { per_user_per_hour, per_account_per_day } = settings.sms.limits;
  const now = Date.now();
  if (userId && (await countSms(db, accountId, new Date(now - HOUR), userId)) >= per_user_per_hour)
    throw new AppError('rate_limited', 'SMS limit per person reached', {
      reason: 'sms_user_limit',
      limit: per_user_per_hour,
      retry_after_ms: HOUR,
    });
  if ((await countSms(db, accountId, new Date(now - DAY))) >= per_account_per_day)
    throw new AppError('rate_limited', 'SMS limit of the account reached', {
      reason: 'sms_account_limit',
      limit: per_account_per_day,
      retry_after_ms: DAY,
    });
};

/** The provider's error as one of ours (the message never carries the number or the text). */
const providerError = (e: unknown): AppError => {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === SMS_SENDER_NOT_CONFIGURED || msg === 'sms_not_configured')
    return new AppError('sms_not_configured', 'SMS is not set up (provider keys or sender id)');
  if (msg === 'sms: invalid_phone')
    return new AppError('sms_unsupported_number', 'The SMS provider cannot send to this number', {
      reason: 'unsupported_destination',
    });
  return new AppError('external_error', 'The SMS provider failed', {
    provider_error: msg.replace(/^sms:\s*/, '').slice(0, 80),
  });
};

/** A template text filled from the item (`{item.*}` only); unknown paths render empty. */
export const renderSmsText = (template: string, lookup: TemplateLookup, opts?: Parameters<typeof renderTemplate>[2]) =>
  renderTemplate(template, (p) => (p === 'item' || p.startsWith('item.') ? lookup(p) : undefined), opts).text.trim();

export type DeliverInput = {
  item: ItemRow;
  column: ColumnRow;
  to: string;
  text: string;
  settings: AccountSettings;
  /** Set when an automation sends: its sends count for the account's budget only. */
  automationId?: string;
  /** Runs the logging writes (an automation passes its run scope so the rows are the run's). */
  inTx: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
};

/**
 * Checks the budgets, sends through the provider and logs the update (source `sms`, author = the sender, meta
 * `{sms: {to, column_id, provider_id, automation_id?}}`) with an `update.created` event. Returns the update id.
 */
export const deliverSms = async (deps: Pick<AppDeps, 'db' | 'sms'>, a: Actor, p: DeliverInput) => {
  const text = p.text.trim();
  if (!text) throw new AppError('validation_failed', 'sms_empty_text');
  if (text.length > SMS_MAX_LENGTH)
    throw new AppError('validation_failed', 'sms_too_long', { max_length: SMS_MAX_LENGTH, length: text.length });
  await assertBudget(deps.db, a.ctx.accountId, p.settings, p.automationId ? null : a.user.id);
  let providerId: string | null;
  try {
    providerId = (
      await deps.sms.send({
        to: p.to,
        text,
        senderId: await smsSenderId(deps.db, a.ctx.accountId),
        accountId: a.ctx.accountId,
      })
    ).id;
  } catch (e) {
    throw providerError(e);
  }
  const id = newId();
  const body = renderUpdateBody(text);
  await p.inTx(async (tx) => {
    await insertUpdate(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId: p.item.boardId,
      itemId: p.item.id,
      parentUpdateId: null,
      bodyHtml: body.html,
      bodyText: text,
      bodyJson: null,
      source: 'sms',
      meta: {
        sms: {
          to: p.to,
          column_id: p.column.key,
          provider_id: providerId,
          ...(p.automationId ? { automation_id: p.automationId } : {}),
        },
      },
      createdBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'update.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: p.item.boardId,
      itemId: p.item.id,
      after: { update_id: id, parent_update_id: null, mentions: [], source: 'sms', column_key: p.column.key },
    });
  });
  return { updateId: id, providerId, segments: smsSegments(text) };
};

/** The lookup of `{item.*}` over the item as this person sees it (hidden columns are not there). */
const itemLookup = async (deps: Pick<AppDeps, 'db' | 'env'>, a: Actor, item: ItemRow, columns: ColumnRow[]) => {
  const { db } = deps;
  const calc = await calculatorFor(db, a, [item.id]);
  const dto = itemDto(calc, item, columns);
  const board = await findBoard(db, a.ctx.accountId, item.boardId);
  const topBoardId = board?.parentBoardId ?? item.boardId;
  const appUrl = await webOrigin(deps);
  const url = `${appUrl}/a/${a.ctx.account.slug}/b/${topBoardId}/i/${item.id}`;
  const group = item.groupId ? await findGroup(db, item.boardId, item.groupId) : null;
  const names = await memberNames(db, a.ctx.accountId, dto.created_by ? [dto.created_by] : []);
  return buildLookup({
    item: { item: dto, columns, url, groupTitle: group?.title },
    board: { id: topBoardId, name: board?.name ?? '', url: `${appUrl}/a/${a.ctx.account.slug}/b/${topBoardId}` },
    actor: { id: a.user.id, name: a.user.name, email: a.user.email },
    creatorName: (id) => (id && names.get(id)) || '',
    today: new Date().toISOString().slice(0, 10),
    now: new Date(),
    automation: { title: '' },
    runId: '',
  });
};

/**
 * POST /items/{id}/sms — the item must be readable, the phone column visible and offering "sms" (its click actions
 * on), the person allowed by the account's SMS policy, the number one the provider delivers to, and the budgets
 * not used up. `dry_run` resolves the number and the text and sends nothing.
 */
export const sendItemSms = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'sms'>,
  a: Actor,
  itemId: string,
  input: SendItemSms,
): Promise<SendItemSmsResult> => {
  const { db } = deps;
  const { item, access } = await loadItem(db, a, itemId);
  const settings = await loadAccountSettings(db, a.ctx.accountId);
  assertMaySend(settings, a.ctx.role);
  const columns = await visibleColumns(db, access);
  const column = columns.find((c) => c.key === input.column_id);
  if (!column) throw new AppError('not_found', 'Column not found');
  if (column.type !== 'phone' || !columnTypes.get(column.type))
    throw new AppError('validation_failed', 'not_a_phone_column', { column_id: column.key });
  const cfg = phoneColumnConfig(column.settings);
  if (!cfg.enabled || !cfg.actions.includes('sms'))
    throw new AppError('forbidden', 'sms_off_for_column', { column_id: column.key });

  const value = (await itemCells(db, item.id)).find((c) => c.columnId === column.id)?.value ?? null;
  const to = smsRecipient(deps, column, value, settings.locale.country);

  let text: string;
  if (input.template_id) {
    const template = settings.sms.templates.find((t) => t.id === input.template_id);
    if (!template) throw new AppError('not_found', 'SMS template not found');
    const lookup = await itemLookup(deps, a, item, columns);
    text = renderSmsText(template.text, lookup, { region: await actorRegion(db, a) });
  } else text = input.text!.trim();
  if (!text) throw new AppError('validation_failed', 'sms_empty_text');

  if (input.dry_run)
    return { sent: false, to, text, segments: smsSegments(text), provider_message_id: null, update: null };
  if (deps.sms.configured === false) throw new AppError('sms_not_configured', 'SMS is not set up (provider keys)');

  const out = await deliverSms(deps, a, {
    item,
    column,
    to,
    text,
    settings,
    inTx: (fn) => db.transaction(fn),
  });
  const threads = await listUpdates(db, a, item.id);
  const found = threads.find((u) => u.id === out.updateId);
  let update: SendItemSmsResult['update'] = null;
  if (found) {
    const { replies: _replies, pinned: _pinned, ...entry } = found;
    update = { ...entry, parent_update_id: null };
  }
  return { sent: true, to, text, segments: out.segments, provider_message_id: out.providerId, update };
};

/** For the automation action: the account settings and the recipient, with the policy applied to the owner. */
export const prepareAutomationSms = async (
  deps: Pick<AppDeps, 'db' | 'sms'>,
  a: Actor,
  column: ColumnRow,
  value: unknown,
) => {
  const settings = await loadAccountSettings(deps.db, a.ctx.accountId);
  assertMaySend(settings, a.ctx.role);
  return { settings, to: smsRecipient(deps, column, value, settings.locale.country) };
};
