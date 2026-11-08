// SPDX-License-Identifier: AGPL-3.0-only
import { accountSettingsSchema, AppError, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { insertTemplate } from './board-copy.repo';
import { saveAsTemplate } from './board-copy.service';
import { loadBoardAccess } from './boards.access';
import {
  findSubBoard,
  findTemplate,
  listBuiltinTemplates,
  markTemplateDraft,
  templateEditOf,
  updateBoardRow,
} from './boards.repo';
import { createBoard, listTemplates, listVisibleWorkspaces } from './boards.service';
import { accountLocale, st } from '../../lib/i18n';

/** Who may make templates without a board (duplicate): the roles that create boards. */
const assertCreator = (a: Actor) => {
  if (a.ctx.role !== 'admin' && a.ctx.role !== 'member') throw new AppError('forbidden', 'cannot_create_templates');
};

/**
 * POST /templates/:key/duplicate (fix2): a copy of any template I see (built-in or the account's) as a new
 * template of this account, mine to edit. The original stays.
 */
export const duplicateTemplate = async (db: Db, a: Actor, key: string, input: { name?: string }) => {
  assertCreator(a);
  const hidden = new Set(accountSettingsSchema.parse(await getAccountSettings(db, a.ctx.accountId)).hidden_templates);
  const source = await findTemplate(db, a.ctx.accountId, key);
  if (!source || (!source.accountId && hidden.has(key))) throw new AppError('not_found', 'Template not found');
  const copyKey = `acct_${newId().toLowerCase()}`;
  const name = (
    input.name?.trim() || st('server.copyOf', { name: source.name }, await accountLocale(db, a.ctx.accountId))
  ).slice(0, 255);
  await db.transaction(async (tx) => {
    await insertTemplate(tx, {
      id: newId(),
      accountId: a.ctx.accountId,
      kind: source.kind,
      key: copyKey,
      name,
      description: source.description,
      category: source.category,
      snapshot: { ...(source.snapshot as Record<string, unknown>), key: copyKey, name },
      isBuiltin: false,
      createdBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'template.created',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { key: copyKey, name },
      meta: { duplicated_from: key },
    });
  });
  return (await listTemplates(db, a)).find((t) => t.key === copyKey)!;
};

/** GET /templates/hidden — built-in templates an admin removed from this account (or replaced by an edited copy). */
export const hiddenBuiltinTemplates = async (db: Db, a: Actor) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const hidden = new Set(accountSettingsSchema.parse(await getAccountSettings(db, a.ctx.accountId)).hidden_templates);
  return (await listBuiltinTemplates(db))
    .filter((t) => hidden.has(t.key))
    .map((t) => ({ key: t.key, name: t.name, description: t.description }));
};

/** POST /templates/:key/restore — a removed built-in template is back in this account's list (admins). */
export const restoreBuiltinTemplate = async (db: Db, a: Actor, key: string) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const settings = accountSettingsSchema.parse(await getAccountSettings(db, a.ctx.accountId));
  const builtin = (await listBuiltinTemplates(db)).find((t) => t.key === key);
  if (!builtin || !settings.hidden_templates.includes(key)) throw new AppError('not_found', 'Template not found');
  await db.transaction(async (tx) => {
    await upsertAccountSettings(
      tx,
      a.ctx.accountId,
      { ...settings, hidden_templates: settings.hidden_templates.filter((k) => k !== key) },
      a.user.id,
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'template.restored',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { key, name: builtin.name },
    });
  });
  return (await listTemplates(db, a)).find((t) => t.key === key)!;
};

// ---- a template's working board (fix3) ----
const KIND = { public: 'main', share: 'shareable', private: 'private' } as const;

/**
 * POST /templates/:key/draft — my working board of a template I may edit: the open one, else a new board made
 * from it and marked `settings.template_edit` (hidden from the sidebar, search, My Work and favourites). One per
 * template per user.
 */
export const startTemplateDraft = async (
  db: Db,
  a: Actor,
  key: string,
  input: { name?: string; workspace_id?: string },
) => {
  const tpl = (await listTemplates(db, a)).find((t) => t.key === key);
  if (!tpl) throw new AppError('not_found', 'Template not found');
  if (!tpl.can_edit) throw new AppError('forbidden', 'not_your_template');
  if (tpl.draft_board_id) return { board_id: tpl.draft_board_id };
  const workspaceId = input.workspace_id ?? (await listVisibleWorkspaces(db, a))[0]?.id;
  if (!workspaceId) throw new AppError('not_found', 'Workspace not found');
  const source = (await findTemplate(db, a.ctx.accountId, key))!;
  const boardKind = (source.snapshot as { board_kind?: keyof typeof KIND }).board_kind ?? 'public';
  const board = await createBoard(db, a, {
    name: (
      input.name ?? st('server.templateDraft', { name: tpl.name }, await accountLocale(db, a.ctx.accountId))
    ).slice(0, 255),
    workspace_id: workspaceId,
    kind: KIND[boardKind] ?? 'main',
    template_key: key,
  });
  const mark = { key, name: tpl.name, user_id: a.user.id, with_items: tpl.item_count > 0 };
  await markTemplateDraft(db, board.id, mark);
  return { board_id: board.id };
};

/** The working board of a template, mine (anyone else: not found). */
const myDraft = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const mark = templateEditOf(access.board);
  if (!mark || mark.user_id !== a.user.id) throw new AppError('not_found', 'Template draft not found');
  return { access, mark };
};

/** The working board goes for good: not to the trash, it was never a board of the account. */
const dropDraft = async (db: Db, boardId: string) => {
  const now = new Date();
  await updateBoardRow(db, boardId, { deletedAt: now });
  const sub = await findSubBoard(db, boardId);
  if (sub) await updateBoardRow(db, sub.id, { deletedAt: now });
};

/** POST /boards/:id/template-draft/save — saved over its template, then the working board goes. */
export const saveTemplateDraft = async (db: Db, a: Actor, boardId: string, input: { with_items?: boolean }) => {
  const { mark } = await myDraft(db, a, boardId);
  const current = await findTemplate(db, a.ctx.accountId, mark.key);
  const saved = await saveAsTemplate(db, a, boardId, {
    name: current?.name ?? mark.name,
    with_items: input.with_items ?? mark.with_items,
    replace_key: mark.key,
  });
  await dropDraft(db, boardId);
  return saved;
};

/** DELETE /boards/:id/template-draft — "ביטול עריכה": the working board goes, the template stays as it was. */
export const discardTemplateDraft = async (db: Db, a: Actor, boardId: string) => {
  await myDraft(db, a, boardId);
  await dropDraft(db, boardId);
};
