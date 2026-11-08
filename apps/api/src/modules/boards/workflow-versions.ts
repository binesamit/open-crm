// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError, newId, statusWorkflowSchema, validateConditions, type StatusWorkflow } from '@bines/shared';
import type { Db } from '../../db/client';
import { statusWorkflowVersions } from '../../db/schema';
import { accountEnv, queryEnvOf } from '../automations/engine/context';
import { assertBoard, isOwnerOrAdmin, loadBoardAccess, type BoardAccess } from './boards.access';
import { findColumnByKey, findSubBoard, listColumns, type ColumnRow } from './boards.repo';
import type { Actor } from '../../types';

const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/**
 * a status column's settings carry its workflow. Settings sent without one keep the stored workflow (the
 * label editor and older clients never drop it); a change is the board owner's or an admin's, its required columns
 * must be on the board and its conditions must plan. Returns the settings to store and whether the workflow changed.
 */
export const prepareWorkflowSettings = async (
  db: Db,
  a: Actor,
  access: BoardAccess,
  column: ColumnRow,
  settings: Record<string, unknown>,
): Promise<{ settings: Record<string, unknown>; changed: boolean }> => {
  if (column.type !== 'status') return { settings, changed: false };
  const stored = (column.settings as { workflow?: unknown }).workflow;
  if (!('workflow' in settings) || settings.workflow === undefined)
    return { settings: stored === undefined ? settings : { ...settings, workflow: stored }, changed: false };
  if (same(settings.workflow, stored)) return { settings, changed: false };
  if (!isOwnerOrAdmin(access)) throw new AppError('forbidden', 'workflow_owner_only');
  const wf = settings.workflow as StatusWorkflow;
  const columns = await listColumns(db, column.boardId);
  const keys = new Set(columns.map((c) => c.key));
  for (const t of wf.transitions) {
    const unknown = [...(t.required ?? []), ...(t.popup?.fields ?? []).map((f) => f.column_id)].find(
      (k) => !keys.has(k),
    );
    if (unknown) throw new AppError('validation_failed', `workflow_unknown_column:${unknown}`);
  }
  if (wf.transitions.some((t) => t.conditions)) {
    const env = await queryEnvOf(db, a.ctx.accountId, columns, await accountEnv(db, a.ctx.accountId));
    for (const t of wf.transitions) validateConditions(t.conditions, env);
  }
  // a subitems rule (and a popup's subitems section) names columns of the board the subitems live on.
  if (wf.transitions.some((t) => t.subitems || t.popup?.subitems)) {
    const sub = access.board.parentBoardId ? access.board : await findSubBoard(db, column.boardId);
    const subColumns = sub ? await listColumns(db, sub.id) : [];
    const subKeys = new Set(['name', ...subColumns.map((c) => c.key)]);
    for (const t of wf.transitions) {
      const unknown = [
        ...(t.subitems?.required ?? []),
        ...(t.popup?.subitems?.fields ?? []).map((f) => f.column_id),
      ].find((k) => !subKeys.has(k));
      if (unknown) throw new AppError('validation_failed', `workflow_unknown_column:${unknown}`);
    }
    if (wf.transitions.some((t) => t.subitems?.conditions)) {
      const env = await queryEnvOf(db, a.ctx.accountId, subColumns, await accountEnv(db, a.ctx.accountId));
      for (const t of wf.transitions) validateConditions(t.subitems?.conditions, env);
    }
  }
  return { settings, changed: true };
};

/** Saves the workflow as the column's next version (inside the column update's transaction). */
export const recordWorkflowVersion = async (tx: Db, a: Actor, column: ColumnRow, workflow: unknown) => {
  const [last] = await tx
    .select({ v: sql<number>`coalesce(max(${statusWorkflowVersions.version}), 0)` })
    .from(statusWorkflowVersions)
    .where(eq(statusWorkflowVersions.columnId, column.id));
  await tx.insert(statusWorkflowVersions).values({
    id: newId(),
    accountId: a.ctx.accountId,
    boardId: column.boardId,
    columnId: column.id,
    version: Number(last?.v ?? 0) + 1,
    workflow: workflow as Record<string, unknown>,
    createdBy: a.user.id,
  });
};

const loadStatusColumn = async (db: Db, a: Actor, boardId: string, key: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'board.read');
  const column = await findColumnByKey(db, boardId, key);
  if (!column || column.type !== 'status') throw new AppError('not_found', 'Column not found');
  return { access, column };
};

/** The saved versions of a status column's workflow, newest first. */
export const listWorkflowVersions = async (db: Db, a: Actor, boardId: string, key: string) => {
  const { column } = await loadStatusColumn(db, a, boardId, key);
  const rows = await db
    .select()
    .from(statusWorkflowVersions)
    .where(eq(statusWorkflowVersions.columnId, column.id))
    .orderBy(desc(statusWorkflowVersions.version))
    .limit(100);
  return rows.map((r) => ({
    version: r.version,
    workflow: r.workflow,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  }));
};

/** One saved version's workflow, for a restore (the owner or an admin; the restore is saved as a new version). */
export const workflowVersion = async (db: Db, a: Actor, boardId: string, key: string, version: number) => {
  const { access, column } = await loadStatusColumn(db, a, boardId, key);
  if (!isOwnerOrAdmin(access)) throw new AppError('forbidden', 'workflow_owner_only');
  const [row] = await db
    .select()
    .from(statusWorkflowVersions)
    .where(and(eq(statusWorkflowVersions.columnId, column.id), eq(statusWorkflowVersions.version, version)))
    .limit(1);
  if (!row) throw new AppError('not_found', 'Version not found');
  return { column, workflow: statusWorkflowSchema.parse(row.workflow) };
};
