// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  AppError,
  applyTemplate,
  extractTemplate,
  newId,
  proposeSlots,
  recipeSchema,
  recipeText,
  templateSlotSchema,
  type AutomationTemplateDto,
  type AutomationTemplateList,
  type installAutomationTemplateSchema,
  type saveAutomationTemplateSchema,
  type TemplateProposal,
  type TemplateSlot,
  type updateAutomationTemplateSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { automationTemplates } from '../../db/schema';
import { loadSettings } from '../accounts/accounts.service';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listColumns, listGroups } from '../boards/boards.repo';
import type { Actor } from '../items/items.service';
import { createAutomation, loadAutomation, redactTitle } from './automations.service';

/**
 * Account automation templates ("save as template"): any automation → a template of the account whose
 * board references are slots; installed on another board by picking them again (proposed by type and title).
 * Admins manage them (members too when the account allows it: `permissions.members_manage_automation_templates`);
 * every member may install one on a board where they may create automations.
 */
type Row = typeof automationTemplates.$inferSelect;

/** Members and admins use templates; viewers and guests make no automations. */
const assertUse = (a: Actor) => {
  if (a.ctx.role !== 'admin' && a.ctx.role !== 'member') throw new AppError('forbidden', 'automation_templates_use');
};

export const mayManageTemplates = async (db: Db, a: Actor) =>
  a.ctx.role === 'admin' ||
  (a.ctx.role === 'member' &&
    (await loadSettings(db, a.ctx.accountId)).permissions.members_manage_automation_templates);

const assertManage = async (db: Db, a: Actor) => {
  if (!(await mayManageTemplates(db, a))) throw new AppError('forbidden', 'automation_templates_manage');
};

const slotsOf = (row: Pick<Row, 'slots'>): TemplateSlot[] =>
  (row.slots ?? []).flatMap((s) => {
    const p = templateSlotSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });

/** The template read as a sentence, with the titles its slots had on the board it came from. */
const sentenceOf = (row: Row) => {
  const parsed = recipeSchema.safeParse(row.recipe);
  if (!parsed.success) return row.name;
  const slots = slotsOf(row);
  const cols = (board: 'main' | 'sub') =>
    slots
      .filter((s) => s.kind === 'column' && s.board === board)
      .map((s) => ({ key: s.id.split(':').slice(2).join(':'), title: s.title, type: s.column_type ?? '' }));
  try {
    return recipeText(parsed.data, {
      columns: cols('main'),
      subColumns: cols('sub'),
      groups: slots.filter((s) => s.kind === 'group').map((s) => ({ id: s.id.slice('group:'.length), title: s.title })),
    });
  } catch {
    return row.name;
  }
};

const dto = (row: Row): AutomationTemplateDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  category: row.category,
  recipe: row.recipe,
  slots: slotsOf(row),
  sentence: sentenceOf(row),
  source_automation_id: row.sourceAutomationId,
  pack_key: row.packKey,
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

const findTemplate = async (db: Db, accountId: string, id: string) => {
  const row = (
    await db
      .select()
      .from(automationTemplates)
      .where(
        and(
          eq(automationTemplates.accountId, accountId),
          eq(automationTemplates.id, id),
          isNull(automationTemplates.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new AppError('not_found', 'Template not found');
  return row;
};

const event = (db: Db, a: Actor, type: string, row: Row, extra: Record<string, unknown> = {}) =>
  recordEvent(db, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    meta: { automation_template_id: row.id, name: row.name, ...extra },
  });

export const listAutomationTemplates = async (db: Db, a: Actor): Promise<AutomationTemplateList> => {
  assertUse(a);
  const rows = await db
    .select()
    .from(automationTemplates)
    .where(and(eq(automationTemplates.accountId, a.ctx.accountId), isNull(automationTemplates.deletedAt)))
    .orderBy(desc(automationTemplates.createdAt));
  return { data: rows.map(dto), can_manage: await mayManageTemplates(db, a) };
};

export const getAutomationTemplate = async (db: Db, a: Actor, id: string) => {
  assertUse(a);
  return dto(await findTemplate(db, a.ctx.accountId, id));
};

/** The board's references as a template reads them: its columns, its sub-board's and its groups. */
const templateBoard = async (db: Db, boardId: string) => {
  const [columns, groups, sub] = await Promise.all([
    listColumns(db, boardId),
    listGroups(db, boardId),
    findSubBoard(db, boardId),
  ]);
  const subColumns = sub ? await listColumns(db, sub.id) : null;
  const shape = (cs: typeof columns) =>
    cs.map((c) => ({ key: c.key, type: c.type, title: c.title, settings: c.settings as Record<string, unknown> }));
  return {
    columns: shape(columns),
    subColumns: subColumns ? shape(subColumns) : null,
    groups: groups.map((g) => ({ id: g.id, title: g.title })),
  };
};

/** "Save as template" from any automation I can read. Secrets stay behind (a webhook's URL becomes a slot). */
export const saveAsTemplate = async (
  db: Db,
  a: Actor,
  automationId: string,
  input: z.infer<typeof saveAutomationTemplateSchema>,
) => {
  await assertManage(db, a);
  const { row: automation } = await loadAutomation(db, a, automationId);
  const { recipe, slots } = extractTemplate(
    automation.recipe as unknown as Record<string, unknown>,
    await templateBoard(db, automation.boardId!),
  );
  const [row] = await db
    .insert(automationTemplates)
    .values({
      id: newId(),
      accountId: a.ctx.accountId,
      // A title may quote a hook URL (titles from before AI-RT8): only its origin travels.
      name: (input.name ?? redactTitle(automation.title)).slice(0, 255),
      description: input.description || null,
      category: input.category || null,
      recipe,
      slots,
      sourceAutomationId: automation.id,
      createdBy: a.user.id,
    })
    .returning();
  await event(db, a, 'automation_template.created', row!, { source_automation_id: automation.id });
  return dto(row!);
};

export const updateAutomationTemplate = async (
  db: Db,
  a: Actor,
  id: string,
  input: z.infer<typeof updateAutomationTemplateSchema>,
) => {
  await assertManage(db, a);
  const row = await findTemplate(db, a.ctx.accountId, id);
  const [next] = await db
    .update(automationTemplates)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.category !== undefined ? { category: input.category || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(automationTemplates.id, row.id))
    .returning();
  await event(db, a, 'automation_template.updated', next!);
  return dto(next!);
};

export const deleteAutomationTemplate = async (db: Db, a: Actor, id: string) => {
  await assertManage(db, a);
  const row = await findTemplate(db, a.ctx.accountId, id);
  await db.update(automationTemplates).set({ deletedAt: new Date() }).where(eq(automationTemplates.id, row.id));
  await event(db, a, 'automation_template.deleted', row);
  return { ok: true as const };
};

/** A target board I may add automations to (its own board, never a sub-board). */
const targetBoard = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'automation.manage');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'automations_live_on_the_main_board');
  return access;
};

/** The install form: each slot with what fits on the board and the proposed pick. */
export const templateProposal = async (
  db: Db,
  a: Actor,
  id: string,
  boardId: string,
  chosen: Record<string, string> = {},
): Promise<TemplateProposal> => {
  assertUse(a);
  const row = await findTemplate(db, a.ctx.accountId, id);
  await targetBoard(db, a, boardId);
  const board = await templateBoard(db, boardId);
  const slots = slotsOf(row);
  return {
    board_id: boardId,
    slots: proposeSlots(slots, board, chosen),
    needs_subitems: !board.subColumns && slots.some((s) => s.board === 'sub'),
  };
};

/**
 * Install: the slots filled (picks over proposals), then saved like any automation — validated against the board,
 * owned by me, off unless asked (the same as a duplicated automation).
 */
export const installAutomationTemplate = async (
  db: Db,
  a: Actor,
  id: string,
  input: z.infer<typeof installAutomationTemplateSchema>,
) => {
  assertUse(a);
  const row = await findTemplate(db, a.ctx.accountId, id);
  await targetBoard(db, a, input.board_id);
  const board = await templateBoard(db, input.board_id);
  const slots = slotsOf(row);
  const { recipe, missing, proposals } = applyTemplate(row.recipe, slots, board, input.mapping);
  if (missing.length)
    throw new AppError('invalid_recipe', 'Some blanks of the template have nothing to fit on this board', {
      issues: missing.map((slot) => ({
        path: `slots.${slot}`,
        code: 'slot_unfilled',
        detail: proposals.find((p) => p.id === slot)?.title ?? slot,
      })),
    });
  const created = await createAutomation(db, a, input.board_id, {
    title: input.title ?? row.name,
    recipe,
    is_active: input.is_active,
  });
  await event(db, a, 'automation_template.installed', row, { automation_id: created.id, board_id: input.board_id });
  return created;
};
