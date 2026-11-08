// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import {
  AppError,
  canBoard,
  type Form,
  formIsRelation,
  formVisibleOnly,
  formInputOf,
  formQuestionAllowed,
  formQuestionSchema,
  formSettingsSchema,
  newId,
  newQuestionId,
  type FormQuestion,
  type FormSettings,
  type UpdateFormInput,
} from '@bines/shared';
import { assertFeature } from '../billing/entitlements';
import { z } from 'zod';
import type { Db } from '../../db/client';
import type { AppDeps, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { findMembership } from '../accounts/accounts.repo';
import { type BoardAccess, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { findGroup, listColumns, type ColumnRow } from '../boards/boards.repo';
import { ownUploadedAssets } from '../files/files.service';
import { findView } from '../views/views.repo';
import type { ViewRow } from '../views/views.repo';
import { isAccountMember } from '../items/items.repo';
import { convertAnswer } from './forms.values';
import { checkHiddenItem, formActor, hiddenSourceOf } from './forms.hidden';
import { forgetFormPage } from './forms.csp';
import { type CaptchaKeys, formAccountCaptcha, formCaptchaKeys, loadAccountCaptcha } from '../captcha/captcha.service';
import { countSubmissions, findFormByView, type FormRow, insertForm, updateFormRow } from './forms.repo';
import { findItemTemplate } from '../item-templates/item-templates.repo';
import { variablesOf } from '../item-templates/item-templates.service';

type Deps = Pick<AppDeps, 'db' | 'secrets'>;

/** 24 characters of [a-z0-9] (~124 bits): the public link cannot be guessed. */
export const newFormToken = () => {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(24)].map((b) => abc[b % abc.length]).join('');
};

/** What `forms.settings` holds: the editor's settings + the sealed Turnstile secret (server only). */
type StoredSettings = FormSettings & { turnstile_secret_sealed?: string };

export const sealedSecretOf = (row: Pick<FormRow, 'settings'>): string | null => {
  const v = (row.settings as { turnstile_secret_sealed?: unknown } | null)?.turnstile_secret_sealed;
  return typeof v === 'string' && v ? v : null;
};
export const settingsOf = (row: Pick<FormRow, 'settings'>): FormSettings => {
  const parsed = formSettingsSchema.safeParse(row.settings ?? {});
  const settings = parsed.success ? parsed.data : formSettingsSchema.parse({});
  // Saved before Turnstile had modes: a form with its own keys kept asking for the check — `on`.
  const raw = (row.settings ?? {}) as { captcha_mode?: unknown };
  if (raw.captcha_mode === undefined)
    return { ...settings, captcha_mode: settings.turnstile_site_key && sealedSecretOf(row) ? 'on' : 'inherit' };
  return settings;
};
/** The form's own Turnstile keys (both set), or null — the account's are used then. */
export const ownCaptchaKeys = (row: Pick<FormRow, 'settings'>): CaptchaKeys | null => {
  const site = settingsOf(row).turnstile_site_key;
  const sealed = sealedSecretOf(row);
  return site && sealed ? { site_key: site, secret_sealed: sealed } : null;
};
/** The keys a submission to this form is checked with, or null. */
export const captchaKeysOfForm = (db: Db, row: Pick<FormRow, 'settings' | 'accountId'>) =>
  formCaptchaKeys(db, {
    accountId: row.accountId,
    mode: settingsOf(row).captcha_mode ?? 'inherit',
    own: ownCaptchaKeys(row),
  });
export const questionsOf = (row: Pick<FormRow, 'questions'>): FormQuestion[] => {
  const parsed = z.array(formQuestionSchema).safeParse(row.questions ?? []);
  return parsed.success ? parsed.data : [];
};

/**
 * Who may change a form: the same people who may save its view (15 §3) — board editors (view.update), owners and
 * admins (view.manage), or its creator where they may create views; a locked view only owners/admins.
 */
const canManage = (access: BoardAccess, view: ViewRow, userId: string) => {
  const manage = canBoard(access.perm, 'view.manage').ok;
  if (view.visibility === 'private') return view.createdBy === userId;
  if (view.isLocked) return manage;
  return (
    manage ||
    canBoard(access.perm, 'view.update').ok ||
    (view.createdBy === userId && canBoard(access.perm, 'view.create').ok)
  );
};

/** A form view the actor can see (another user's private view is a 404), with its board access. */
const loadFormView = async (db: Db, a: Actor, viewId: string) => {
  const view = await findView(db, a.ctx.accountId, viewId);
  if (!view || view.type !== 'form' || (view.visibility === 'private' && view.createdBy !== a.user.id))
    throw new AppError('not_found', 'Form not found');
  const access = await loadBoardAccess(db, a.ctx, a.user, view.boardId);
  return { view, access };
};

const formDto = async (db: Db, row: FormRow, canEdit: boolean): Promise<Form> => ({
  id: row.id,
  view_id: row.viewId,
  board_id: row.boardId,
  title: row.title,
  description: row.description ?? '',
  enabled: row.isActive,
  access: row.requireLogin ? 'members' : 'public',
  token: row.slug,
  target_group_id: row.targetGroupId,
  questions: questionsOf(row),
  settings: settingsOf(row),
  turnstile_secret_set: !!sealedSecretOf(row),
  account_captcha: formAccountCaptcha(await loadAccountCaptcha(db, row.accountId)),
  submissions_count: await countSubmissions(db, row.id),
  revision: row.revision,
  can_manage: canEdit,
});

/** A new form starts with the item name as its one (required) question. */
const defaultQuestions = (columns: ColumnRow[]): FormQuestion[] => {
  const name = columns.find((c) => c.type === 'name');
  return name ? [formQuestionSchema.parse({ id: newQuestionId(), column_key: name.key, required: true })] : [];
};

/** GET /views/:id/form — the form of a form view; created with defaults the first time it is opened. */
export const getForm = async (deps: Deps, a: Actor, viewId: string) => {
  const { db } = deps;
  const { view, access } = await loadFormView(db, a, viewId);
  let row = await findFormByView(db, a.ctx.accountId, viewId);
  if (!row) {
    // Plans: a new form is the plan's `forms` (an existing one always opens).
    await assertFeature(db, a.ctx.accountId, 'forms');
    const columns = await listColumns(db, view.boardId);
    await insertForm(db, {
      id: newId(),
      accountId: a.ctx.accountId,
      boardId: view.boardId,
      viewId,
      slug: newFormToken(),
      title: view.name,
      description: null,
      isActive: true,
      requireLogin: false,
      questions: defaultQuestions(columns),
      settings: formSettingsSchema.parse({}),
      createdBy: view.createdBy ?? a.user.id,
    });
    row = (await findFormByView(db, a.ctx.accountId, viewId))!;
  }
  return formDto(db, row, canManage(access, view, a.user.id));
};

/**
 * Checks a question list against the board's columns; throws `invalid_value` with what is wrong. Hidden values from
 * an item are checked with the rights of the person saving and of the form's creator (who reads them on submit).
 */
const checkQuestions = async (
  db: Db,
  a: Actor,
  creator: Actor | null,
  questions: FormQuestion[],
  columns: ColumnRow[],
  saver?: { access: BoardAccess; previous: FormQuestion[] },
) => {
  const previousKeys = new Set((saver?.previous ?? []).map((q) => q.column_key));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const ids = new Set<string>();
  const keys = new Set<string>();
  const before = new Map<string, FormQuestion>();
  const fail = (index: number, reason: string): never => {
    throw new AppError('invalid_value', 'Invalid form question', { index, reason });
  };
  for (const [i, q] of questions.entries()) {
    const column = byKey.get(q.column_key);
    if (!column) fail(i, 'unknown_column');
    if (!formQuestionAllowed(column!.type)) fail(i, 'unsupported_column');
    if (ids.has(q.id)) fail(i, 'duplicate_id');
    if (keys.has(q.column_key)) fail(i, 'duplicate_column');
    ids.add(q.id);
    keys.add(q.column_key);
    // S-84: the form writes as its creator — a question added by someone who may not edit the column would let
    // them write it through the form (a question already on the form stays).
    if (saver && !previousKeys.has(q.column_key) && !columnAllowed(saver.access, column!.restrictedEdit))
      fail(i, 'column_not_editable');
    const input = formInputOf(column!.type);
    const relation = formIsRelation(column!.type);
    // Uploads come from the person filling the form; they cannot be prefilled.
    if (q.hidden && input === 'files') fail(i, 'cannot_hide');
    // a secret comes only from the person — never hidden, prefilled or a link's value.
    if (formVisibleOnly(column!.type) && q.hidden) fail(i, 'cannot_hide');
    // Who sees a connect-boards list is a setting of a visible connect-boards question only.
    if (q.relation_list && (!relation || q.hidden)) fail(i, 'invalid_relation_list');
    if (q.hidden && q.required) fail(i, 'hidden_required');
    const source = q.hidden ? hiddenSourceOf(q) : 'manual';
    if (relation && q.hidden && source !== 'item' && source !== 'url') fail(i, 'invalid_source');
    // An item not picked yet is no value (like an empty fixed value) — the editor saves as the person goes.
    if (source === 'item' && q.hidden_item) {
      const reason = await checkHiddenItem(db, a, creator, column!, q.hidden_item);
      if (reason) fail(i, reason);
    }
    if (source === 'url' && !q.hidden_param) fail(i, 'missing_source');
    if (q.default_value !== undefined && q.default_value !== null && q.default_value !== '') {
      if (input === 'files' || input === 'secret' || relation) fail(i, 'no_default');
      const c = convertAnswer(column!, q.default_value);
      if (!c.ok) fail(i, 'invalid_default');
      // A fixed person must be one of the account's people.
      if (c.ok && c.kind === 'people' && !(await isAccountMember(db, a.ctx.accountId, c.ids)))
        fail(i, 'invalid_default');
    }
    // A condition depends on an earlier question that is shown (one condition per question).
    if (q.condition) {
      const target = before.get(q.condition.question_id);
      // A secret's answer never decides what else shows (the page would have to compare it); nor do linked items.
      const targetInput = formInputOf(byKey.get(target?.column_key ?? '')?.type ?? '');
      if (!target || target.hidden || targetInput === 'secret' || targetInput === 'relation')
        fail(i, 'invalid_condition');
    }
    before.set(q.id, q);
  }
  if (!questions.some((q) => !q.hidden)) fail(0, 'no_visible_question');
};

/** Who the form will act as after this save: its creator, or the saver when the creator left. */
const actingCreator = async (db: Db, a: Actor, createdBy: string): Promise<Actor | null> => {
  if (createdBy === a.user.id) return a;
  try {
    return await formActor(db, { accountId: a.ctx.accountId, createdBy }, a.ctx.account, a.requestId ?? 'form');
  } catch {
    // The creator cannot act (a viewer): the form takes no submissions until someone else saves it.
    return null;
  }
};

/** PATCH /views/:id/form */
export const updateForm = async (deps: Deps, a: Actor, viewId: string, input: UpdateFormInput) => {
  const { db, secrets } = deps;
  const { view, access } = await loadFormView(db, a, viewId);
  if (!canManage(access, view, a.user.id))
    throw new AppError('forbidden', view.isLocked ? 'view_locked' : 'cannot_edit_view');
  const row = await findFormByView(db, a.ctx.accountId, viewId);
  if (!row) throw new AppError('not_found', 'Form not found');

  const patch: Partial<FormRow> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description || null;
  if (input.enabled !== undefined) patch.isActive = input.enabled;
  if (input.access !== undefined) patch.requireLogin = input.access === 'members';
  if (input.target_group_id !== undefined) {
    if (input.target_group_id && !(await findGroup(db, view.boardId, input.target_group_id)))
      throw new AppError('invalid_value', 'Unknown group', { field: 'target_group_id' });
    patch.targetGroupId = input.target_group_id;
  }
  // The form acts as its creator when it creates items; one who left hands the form to whoever saves it next.
  if (!row.createdBy || (await findMembership(db, a.ctx.accountId, row.createdBy))?.status !== 'active')
    patch.createdBy = a.user.id;
  if (input.questions !== undefined) {
    const creator = await actingCreator(db, a, patch.createdBy ?? row.createdBy!);
    await checkQuestions(db, a, creator, input.questions, await listColumns(db, view.boardId), {
      access,
      previous: (row.questions ?? []) as FormQuestion[],
    });
    patch.questions = input.questions;
  }
  if (input.settings !== undefined || input.turnstile_secret !== undefined) {
    const current = row.settings as StoredSettings;
    const next: StoredSettings = { ...settingsOf(row), ...(input.settings ?? {}) };
    // Logo and cover: a new one is the saver's own finished upload (files module) — never another file of the
    // account, which the public form would then serve to anyone (S-56). One already on the form stays.
    const assetIds = [next.logo_asset_id, next.cover_asset_id].filter((x): x is string => !!x);
    const fresh = assetIds.filter(
      (id) => id !== settingsOf(row).logo_asset_id && id !== settingsOf(row).cover_asset_id,
    );
    if (fresh.length) {
      try {
        await ownUploadedAssets(db, a, fresh);
      } catch {
        throw new AppError('invalid_value', 'Unknown or unfinished file', { field: 'settings' });
      }
    }
    // Item templates (phase 2): a template of the form's board the saver may read; each variable is
    // one of its variables, answered by one of the form's questions.
    const chosenTemplate = input.settings?.item_template;
    if (chosenTemplate) {
      const bad = (reason: string): never => {
        throw new AppError('invalid_value', 'Invalid item template', { field: 'settings.item_template', reason });
      };
      const tpl = await findItemTemplate(db, a.ctx.accountId, chosenTemplate.template_id);
      if (!tpl || tpl.boardId !== view.boardId || !canBoard(access.perm, 'item.read').ok)
        bad('item_template_not_found');
      const keys = new Set(variablesOf(tpl!).map((v) => v.key));
      const questionIds = new Set(((input.questions ?? row.questions ?? []) as FormQuestion[]).map((q) => q.id));
      for (const [key, qid] of Object.entries(chosenTemplate.variables)) {
        if (!keys.has(key)) bad('item_template_unknown_variable');
        if (!questionIds.has(qid)) bad('item_template_unknown_question');
      }
    }
    const sealed =
      input.turnstile_secret === undefined
        ? current.turnstile_secret_sealed
        : input.turnstile_secret === null
          ? undefined
          : secrets.seal(input.turnstile_secret);
    // A form that never chose a Turnstile mode keeps "own keys = on, else the account's" until one is chosen.
    const { captcha_mode, ...rest } = next;
    const chosen =
      input.settings?.captcha_mode !== undefined ||
      (row.settings as { captcha_mode?: unknown } | null)?.captcha_mode !== undefined;
    patch.settings = {
      ...rest,
      ...(chosen ? { captcha_mode } : {}),
      ...(sealed ? { turnstile_secret_sealed: sealed } : {}),
    };
    // Switching to "on" needs keys: the form's own pair, or the account's.
    const switchedOn = input.settings?.captcha_mode === 'on' && settingsOf(row).captcha_mode !== 'on';
    if (switchedOn && !ownCaptchaKeys({ settings: patch.settings })) {
      const account = await loadAccountCaptcha(db, a.ctx.accountId);
      if (!formAccountCaptcha(account).keys_ready)
        throw new AppError('invalid_value', 'captcha_keys_missing', { field: 'settings.captcha_mode' });
    }
  }
  const saved = await db.transaction(async (tx) => {
    const updated = await updateFormRow(tx, row.id, patch, input.revision ?? null);
    if (!updated)
      throw new AppError('revision_mismatch', 'The form was saved by someone else', { revision: row.revision });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'view.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: view.boardId,
      before: { id: viewId, form_revision: row.revision },
      // Never the secret.
      after: { id: viewId, form: Object.keys(input).filter((k) => k !== 'turnstile_secret' && k !== 'revision') },
    });
    return updated;
  });
  forgetFormPage(row.slug);
  return formDto(db, saved, true);
};

/** POST /views/:id/form/token — a new public link; the old one stops working at once. */
export const regenerateToken = async (deps: Deps, a: Actor, viewId: string) => {
  const { db } = deps;
  const { view, access } = await loadFormView(db, a, viewId);
  if (!canManage(access, view, a.user.id)) throw new AppError('forbidden', 'cannot_edit_view');
  const row = await findFormByView(db, a.ctx.accountId, viewId);
  if (!row) throw new AppError('not_found', 'Form not found');
  const saved = await db.transaction(async (tx) => {
    const updated = (await updateFormRow(tx, row.id, { slug: newFormToken() }, null))!;
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'view.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: view.boardId,
      after: { id: viewId, form: ['token'] },
    });
    return updated;
  });
  forgetFormPage(row.slug);
  return formDto(db, saved, true);
};
