// SPDX-License-Identifier: AGPL-3.0-only
import { staleRunningConversions } from './conversions.repo';
import { createHash } from 'node:crypto';
import {
  accountDefaultsOf,
  AppError,
  type CellConversion,
  type ColumnConversion,
  type ConversionDependent,
  type ConversionPreview,
  type ConversionSettings,
  CONVERT_BACKUP_DAYS_DEFAULT,
  CONVERT_SYNC_MAX_CELLS,
  CONVERT_WINDOW,
  conversionSupport,
  type ConvertEnv,
  type ConvertOptions,
  type ConvertRequest,
  columnTypes,
  convertCell,
  dateOrderOf,
  deriveValues,
  newId,
  type NewLabel,
  planConversion,
  type PreparedConversion,
  resumeConversion,
} from '@bines/shared';
import { assertFeature } from '../billing/entitlements';
import type { Db } from '../../db/client';
import { enqueueJob } from '../../lib/jobs';
import { accountRegion } from '../accounts/region';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { assertBoard, columnAllowed, isOwnerOrAdmin, loadBoardAccess } from '../boards/boards.access';
import {
  type BoardRow,
  type ColumnRow,
  findBoard,
  findColumnById,
  findColumnByKey,
  updateColumnRow,
} from '../boards/boards.repo';
import type { Actor } from '../items/items.service';
import { boardVisibility, filterVisible } from '../items/visibility';
import { itemsByIds } from '../items/items.repo';
import { recomputeNamesReading } from '../items/names.service';
import { ensureTags } from '../tags/tags.service';
import { listTagRows } from '../tags/tags.repo';
import {
  accountPeople,
  announceProgress,
  type BackupCell,
  backupPage,
  cellsChangedSince,
  cellsOutsideBackup,
  columnCellsPage,
  conversionsOfBoard,
  type ConversionRow,
  countBoardItems,
  deleteBackupRows,
  failedCells,
  findConversion,
  insertBackupCells,
  insertConversion,
  itemNames,
  lastCellChange,
  latestDoneConversion,
  replaceColumnCells,
  setColumnConverting,
  type StoredCell,
  updateConversion,
} from './conversions.repo';
import { restoreDependents, scanDependents, type UndoState } from './conversions.dependents';

/**
 * Column type conversion (D28, the planning notes "COLUMN-CONVERSION"). The preview (dry run) and the conversion run the
 * same shared code (`planConversion` / `convertCell`), so the counts match. The conversion first writes the backup
 * — every cell's original value and the new value computed for it — in windows, then switches in one transaction:
 * the column's cells become the new values (set-based), the type and settings change, the dependents are updated or
 * flagged, one `column.type_changed` event (undoable as one step) and an audit row are written. A failure before
 * the switch leaves the column as it was. Above `CONVERT_SYNC_MAX_CELLS` cells it runs as a background job with the
 * column locked and progress on the board's live channel.
 */

/** Only the board's owners and the account's admins (product decision 7), like deleting a column. */
const loadTarget = async (db: Db, a: Actor, boardId: string, key: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'column.update');
  if (!isOwnerOrAdmin(access)) throw new AppError('forbidden', 'convert_owners_only');
  const column = await findColumnByKey(db, boardId, key);
  if (!column) throw new AppError('not_found', 'Column not found');
  return { access, column };
};

const assertSupported = (from: string, to: string) => {
  const s = conversionSupport(from, to);
  if (!s.ok) throw new AppError('conversion_unsupported', `A ${from} column cannot become ${to}`, { reason: s.reason });
  return s;
};

const envOf = async (db: Db, accountId: string): Promise<ConvertEnv> => ({
  people: await accountPeople(db, accountId),
  tags: (await listTagRows(db, accountId)).map((t) => ({ id: t.id, name: t.name })),
  region: await accountRegion(db, accountId),
  newColumnDefaults: accountDefaultsOf(await getAccountSettings(db, accountId)),
});

const allCells = async (db: Db, columnId: string) => {
  const out: StoredCell[] = [];
  for (let after: string | null = null; ;) {
    const page = await columnCellsPage(db, columnId, after, 5000);
    out.push(...page);
    if (page.length < 5000) return out;
    after = page.at(-1)!.itemId;
  }
};

/** The options the preview shows, defaults filled in (the account's day/month order, start of a timeline…). */
const effectiveOptions = (options: ConvertOptions, env: ConvertEnv, prepared: PreparedConversion): ConvertOptions => ({
  ...options,
  date_order: options.date_order ?? dateOrderOf(env.region?.date_format),
  timeline_side: options.timeline_side ?? 'start',
  people_as: options.people_as ?? 'name',
  number_unit: options.number_unit ?? true,
  ...(prepared.to.type === 'rating' ? { rating_max: prepared.to.settings.max as 3 | 4 | 5 | 10 } : {}),
});

/** Changes whenever the column, its cells, the board's items or the choices change: the preview is stale. */
const fingerprintOf = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);

type Planned = Awaited<ReturnType<typeof planColumn>>;

const planColumn = async (db: Db, a: Actor, column: ColumnRow, req: ConvertRequest) => {
  const options = req.options ?? {};
  const env = await envOf(db, a.ctx.accountId);
  const [cells, itemCount, lastChange] = await Promise.all([
    allCells(db, column.id),
    countBoardItems(db, column.boardId),
    lastCellChange(db, column.id),
  ]);
  const plan = planConversion({
    from: { type: column.type, settings: column.settings },
    toType: req.to_type,
    options,
    env,
    cells: cells.map((c) => ({ itemId: c.itemId, value: c.value })),
    itemCount,
  });
  const fingerprint = fingerprintOf([
    column.id,
    column.type,
    column.settings,
    column.updatedAt.toISOString(),
    lastChange,
    cells.length,
    itemCount,
    req.to_type,
    options,
    plan.counts,
  ]);
  return { env, cells, itemCount, plan, options, fingerprint };
};

const sampleOut = async (db: Db, samples: ReturnType<typeof planConversion>['samples']) => {
  const names = await itemNames(
    db,
    [...samples.converted, ...samples.failed].map((s) => s.item_id),
  );
  const withName = (list: typeof samples.converted) =>
    list.map((s) => ({ ...s, item_name: names.get(s.item_id) ?? '' }));
  return { converted: withName(samples.converted), failed: withName(samples.failed) };
};

const previewOf = async (
  db: Db,
  a: Actor,
  board: BoardRow,
  column: ColumnRow,
  req: ConvertRequest,
  p: Planned,
): Promise<ConversionPreview> => {
  const support = assertSupported(column.type, req.to_type);
  const { dependents } = await scanDependents(db, {
    accountId: a.ctx.accountId,
    board,
    column,
    to: p.plan.prepared.to,
    conversionId: 'preview',
    apply: false,
    userId: a.user.id,
  });
  return {
    column_id: column.key,
    from_type: column.type,
    to_type: req.to_type,
    counts: p.plan.counts,
    samples: await sampleOut(db, p.plan.samples),
    new_labels: p.plan.prepared.newLabels.map(labelOut),
    new_tags: p.plan.prepared.newTags.map(labelOut),
    skipped_labels: p.plan.prepared.skippedLabels.map(labelOut),
    option_keys: support.ok ? support.options : [],
    options: effectiveOptions(p.options, p.env, p.plan.prepared),
    to_settings: p.plan.prepared.to.settings,
    dependents,
    background: p.cells.length > CONVERT_SYNC_MAX_CELLS,
    fingerprint: p.fingerprint,
  };
};

const labelOut = (l: NewLabel) => ({ name: l.name, ...(l.color ? { color: l.color } : {}), count: l.count });

// ---- DTO ----

type Report = { dependents?: ConversionDependent[]; undo?: UndoState; new_labels?: NewLabel[] };

const backupDays = async (db: Db, accountId: string) => {
  const s = (await getAccountSettings(db, accountId)) as { conversions?: { backup_days?: number } };
  const days = s.conversions?.backup_days;
  return typeof days === 'number' && days >= 0 ? days : CONVERT_BACKUP_DAYS_DEFAULT;
};

export const conversionDto = (c: ConversionRow, columnKey: string, days: number): ColumnConversion => {
  const report = (c.report ?? {}) as Report;
  return {
    id: c.id,
    board_id: c.boardId,
    column_id: columnKey,
    kind: c.kind === 'restore' ? 'restore' : 'convert',
    restore_of: c.restoreOf,
    from_type: c.fromType,
    to_type: c.toType,
    status: c.status as ColumnConversion['status'],
    total: c.total,
    done: c.done,
    counts: { items: c.itemCount, converted: c.converted, empty: c.empty, failed: c.failed, partial: c.partial },
    dependents: report.dependents ?? [],
    new_labels: (report.new_labels ?? []).map(labelOut),
    event_id: c.eventId,
    error: c.error,
    created_by: c.createdBy,
    created_at: c.createdAt.toISOString(),
    finished_at: c.finishedAt?.toISOString() ?? null,
    undone_at: c.undoneAt?.toISOString() ?? null,
    backup: !c.backupPurgedAt,
    backup_until: days ? new Date(c.createdAt.getTime() + days * 86_400_000).toISOString() : null,
    failed_marked: c.status === 'done' && c.failed > 0 && !c.failedClearedAt && !c.backupPurgedAt,
  };
};

const dtoOf = async (db: Db, c: ConversionRow) => {
  const column = await findColumnById(db, c.columnId);
  return conversionDto(c, column?.key ?? '', await backupDays(db, c.accountId));
};

// ---- preview / convert ----

/**
 * `POST /boards/:id/columns/:col/convert` — `dry_run` = the preview; else the conversion (with the preview's
 * fingerprint). Small columns convert in the request; large ones are queued and polled / followed live.
 */
export const convertColumn = async (db: Db, a: Actor, boardId: string, key: string, req: ConvertRequest) => {
  const { access, column } = await loadTarget(db, a, boardId, key);
  if (column.convertingId) throw new AppError('column_converting', 'The column is being converted');
  assertSupported(column.type, req.to_type);
  // Plans: becoming an AI column is the plan's `ai`.
  if (req.to_type === 'ai') await assertFeature(db, a.ctx.accountId, 'ai');
  const p = await planColumn(db, a, column, req);
  if (req.dry_run) return { preview: await previewOf(db, a, access.board, column, req, p) };
  if (!req.fingerprint) throw new AppError('validation_failed', 'Preview first: the fingerprint is required');
  if (req.fingerprint !== p.fingerprint)
    throw new AppError('preview_stale', 'The column changed since the preview', {
      preview: await previewOf(db, a, access.board, column, req, p),
    });

  const prepared = p.plan.prepared;
  const id = newId();
  const background = p.cells.length > CONVERT_SYNC_MAX_CELLS;
  await db.transaction(async (tx) => {
    // New tags are account tags: created now (a failed conversion leaves them, like an unused tag).
    if (prepared.to.type === 'tags' && prepared.newTags.length)
      await ensureTags(
        tx,
        a,
        prepared.newTags.map((t) => t.name),
      );
    await insertConversion(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId,
      columnId: column.id,
      kind: 'convert',
      fromType: column.type,
      fromSettings: column.settings,
      toType: prepared.to.type,
      toSettings: prepared.to.settings,
      options: p.options as Record<string, unknown>,
      status: 'running',
      total: p.cells.length,
      itemCount: p.itemCount,
      batchId: newId(),
      report: { new_labels: prepared.newLabels } as Record<string, unknown>,
      createdBy: a.user.id,
    });
    await setColumnConverting(tx, column.id, id);
  });
  if (background && (await enqueueJob(db, CONVERT_TASK, { conversion_id: id }, { maxAttempts: 1 })))
    return { conversion: await dtoOf(db, (await findConversion(db, a.ctx.accountId, id))!) };
  // No job runner (tests, a worker-less dev server): the same windows run in the request.
  await runConversion(db, id, { requestId: a.requestId ?? null, sync: !background });
  return { conversion: await dtoOf(db, (await findConversion(db, a.ctx.accountId, id))!) };
};

export const CONVERT_TASK = 'column.convert';

type RunOpts = { requestId: string | null; sync: boolean };

/** The names a converted cell's keys need (people, tags), as the cell service derives them. */
const keyCtx = (env: ConvertEnv) => {
  const names = new Map([...(env.people ?? []).map((x) => [x.id, x.name] as const)]);
  const tags = new Map((env.tags ?? []).map((t) => [t.id, t.name] as const));
  return { userName: (id: string) => names.get(id), tagName: (id: string) => tags.get(id) };
};

/** One stored cell → its backup row (original value + keys, the new value + keys). */
const backupRow = (
  cell: StoredCell,
  r: CellConversion,
  prepared: PreparedConversion,
  tagIds: Map<string, string>,
  ctx: ReturnType<typeof keyCtx>,
): BackupCell => {
  let value = r.value;
  let outcome = r.outcome;
  if (value !== null && prepared.to.type === 'tags') {
    const ids = (value as { tags: string[] }).tags
      .map((n) => tagIds.get(n.trim().toLowerCase()))
      .filter((x): x is string => !!x);
    value = ids.length ? { tag_ids: [...new Set(ids)] } : null;
    if (!ids.length) outcome = 'failed';
  }
  const keys =
    value === null ? null : deriveValues(columnTypes.get(prepared.to.type)!, prepared.to.settings, value, ctx);
  return {
    itemId: cell.itemId,
    outcome,
    partial: !!r.partial,
    oldValue: cell.value,
    oldText: cell.textValue,
    oldNumber: cell.numberValue,
    oldDate: cell.dateValue,
    oldDateEnd: cell.dateEndValue,
    newValue: value,
    newText: keys?.textValue ?? null,
    newNumber: keys?.numberValue ?? null,
    newDate: keys?.dateValue ?? null,
    newDateEnd: keys?.dateEndValue ?? null,
  };
};

/**
 * Runs a conversion that was created (in the request for small columns, in the `column.convert` job for large
 * ones): the backup in windows of `CONVERT_WINDOW` cells (each its own statement; progress announced), then the
 * switch in one transaction. A failure marks the conversion failed and unlocks the column — nothing changed.
 */
export const runConversion = async (db: Db, conversionId: string, opts: RunOpts) => {
  const row = (await db.query.columnConversions.findFirst({ where: (t, { eq }) => eq(t.id, conversionId) }))!;
  if (!row || row.status !== 'running') return;
  const work = async (tx: Db) => {
    const env = await envOf(tx, row.accountId);
    const prepared = resumeConversion({
      from: { type: row.fromType, settings: row.fromSettings },
      to: { type: row.toType, settings: row.toSettings },
      options: row.options as ConvertOptions,
      env,
    });
    const ctx = keyCtx(env);
    const tagIds = new Map((env.tags ?? []).map((t) => [t.name.trim().toLowerCase(), t.id]));
    let done = 0;
    for (let after: string | null = null; ;) {
      const page = await columnCellsPage(tx, row.columnId, after, CONVERT_WINDOW);
      if (!page.length) break;
      await insertBackupCells(
        tx,
        row.accountId,
        row.id,
        page.map((cell) => backupRow(cell, convertCell(prepared, cell.value), prepared, tagIds, ctx)),
      );
      done += page.length;
      after = page.at(-1)!.itemId;
      if (!opts.sync) {
        await updateConversion(tx, row.id, { done });
        await announceProgress(tx, {
          accountId: row.accountId,
          boardId: row.boardId,
          columnId: row.columnId,
          conversionId: row.id,
        });
      }
      if (page.length < CONVERT_WINDOW) break;
    }
    const finish = async (t: Db) => {
      // Cells written meanwhile by a writer that does not check the lock: convert them now, with the rest.
      const extra = await cellsOutsideBackup(t, row.columnId, row.id);
      if (extra.length) {
        await deleteBackupRows(
          t,
          row.id,
          extra.map((c) => c.itemId),
        );
        await insertBackupCells(
          t,
          row.accountId,
          row.id,
          extra.map((cell) => backupRow(cell, convertCell(prepared, cell.value), prepared, tagIds, ctx)),
        );
      }
      await switchColumn(t, row, opts.requestId);
    };
    if (opts.sync) await finish(tx);
    else await tx.transaction(finish);
  };
  try {
    if (opts.sync) await db.transaction(work);
    else await work(db);
  } catch (err) {
    await db.transaction(async (tx) => {
      await deleteBackupRows(tx, row.id, (await backupItemIds(tx, row.id)) ?? []);
      await updateConversion(tx, row.id, {
        status: 'failed',
        error: err instanceof Error ? err.message.slice(0, 500) : 'failed',
        finishedAt: new Date(),
      });
      await setColumnConverting(tx, row.columnId, null);
    });
    if (opts.sync) throw err;
    return;
  }
  // The converted column feeds the board's computed item names: they follow its new text.
  await recomputeNamesReading(
    db,
    { accountId: row.accountId, actorId: row.createdBy, requestId: opts.requestId },
    row.boardId,
    row.columnId,
  );
};

const backupItemIds = async (db: Db, conversionId: string) => {
  const ids: string[] = [];
  for (let after: string | null = null; ;) {
    const page = await backupPage(db, conversionId, after, 5000);
    ids.push(...page.map((r) => r.itemId));
    if (page.length < 5000) return ids;
    after = page.at(-1)!.itemId;
  }
};

/** The switch (one transaction): cells, type and settings, dependents, the event, the audit row, the counts. */
const switchColumn = async (tx: Db, row: ConversionRow, requestId: string | null) => {
  const column = await findColumnById(tx, row.columnId);
  const board = column && (await findBoard(tx, row.accountId, column.boardId));
  if (!column || !board || column.deletedAt) throw new AppError('not_found', 'Column not found');
  await replaceColumnCells(
    tx,
    {
      columnId: column.id,
      boardId: column.boardId,
      accountId: row.accountId,
      conversionId: row.id,
      userId: row.createdBy,
    },
    'new',
  );
  const counts = await backupCounts(tx, row.id);
  const { dependents, undo } = await scanDependents(tx, {
    accountId: row.accountId,
    board,
    column,
    to: { type: row.toType, settings: row.toSettings },
    conversionId: row.id,
    apply: true,
    userId: row.createdBy,
  });
  await updateColumnRow(tx, column.id, {
    type: row.toType,
    settings: row.toSettings,
    convertingId: null,
    revision: column.revision + 1,
  });
  const empty = Math.max(0, row.itemCount - counts.converted - counts.failed);
  const meta = {
    conversion_id: row.id,
    column_key: column.key,
    column_type: row.toType,
    from_type: row.fromType,
    kind: row.kind,
    ...(row.restoreOf ? { restore_of: row.restoreOf } : {}),
    converted: counts.converted,
    failed: counts.failed,
    partial: counts.partial,
    empty,
  };
  const eventId = await recordEvent(tx, {
    accountId: row.accountId,
    type: 'column.type_changed',
    actorId: row.createdBy,
    requestId,
    boardId: column.boardId,
    columnId: column.id,
    batchId: row.batchId,
    before: { type: row.fromType, settings: row.fromSettings },
    after: { type: row.toType, settings: row.toSettings },
    meta,
  });
  await recordAudit(tx, {
    accountId: row.accountId,
    actorId: row.createdBy,
    action: 'column.type_changed',
    targetType: 'column',
    targetId: column.id,
    payload: { board_id: column.boardId, key: column.key, title: column.title, ...meta },
  });
  const report = { ...(row.report as Report), dependents, undo };
  await updateConversion(tx, row.id, {
    status: 'done',
    done: row.total,
    converted: counts.converted,
    failed: counts.failed,
    partial: counts.partial,
    empty,
    eventId,
    finishedAt: new Date(),
    report: report as Record<string, unknown>,
  });
};

const backupCounts = async (db: Db, conversionId: string) => {
  const counts = { converted: 0, failed: 0, partial: 0 };
  for (let after: string | null = null; ;) {
    const page = await backupPage(db, conversionId, after, 5000);
    for (const r of page) {
      if (r.outcome === 'converted') counts.converted++;
      else if (r.outcome === 'failed') counts.failed++;
    }
    if (page.length < 5000) break;
    after = page.at(-1)!.itemId;
  }
  counts.partial = await partialCount(db, conversionId);
  return counts;
};

// Partial rows are few; counted by the same page reads (kept apart to keep backupPage small).
const partialCount = async (db: Db, conversionId: string) => {
  const row = await db.query.columnConversionCells.findMany({
    where: (t, { and, eq }) => and(eq(t.conversionId, conversionId), eq(t.partial, true)),
    columns: { itemId: true },
  });
  return row.length;
};

// ---- undo / restore ----

/**
 * The undo of a conversion (the `column.type_changed` handler, inside the undo transaction): the original type,
 * settings (labels it created go with them) and every original value back from the backup; views, automations and
 * widgets as they were. Only the latest conversion of the column, and not while one runs.
 */
export const undoConversionTx = async (
  tx: Db,
  a: { ctx: { accountId: string }; user: { id: string }; requestId?: string },
  conversionId: string,
  undoOf: string,
) => {
  const row = await findConversion(tx, a.ctx.accountId, conversionId);
  if (!row || row.status !== 'done') throw new AppError('already_undone', 'Not undoable');
  if (row.backupPurgedAt) throw new AppError('not_undoable', 'backup_purged');
  const column = await findColumnById(tx, row.columnId);
  if (!column || column.deletedAt) throw new AppError('not_undoable', 'Column not found');
  if (column.convertingId) throw new AppError('column_converting', 'The column is being converted');
  const latest = await latestDoneConversion(tx, column.id);
  if (latest?.id !== row.id || column.type !== row.toType)
    throw new AppError('not_undoable', 'later_conversion', { conversion_id: latest?.id });
  await replaceColumnCells(
    tx,
    { columnId: column.id, boardId: column.boardId, accountId: row.accountId, conversionId: row.id, userId: a.user.id },
    'old',
  );
  await updateColumnRow(tx, column.id, {
    type: row.fromType,
    settings: row.fromSettings,
    revision: column.revision + 1,
  });
  await restoreDependents(tx, (row.report as Report).undo, row.id);
  await updateConversion(tx, row.id, { status: 'undone', undoneAt: new Date() });
  const eventId = await recordEvent(tx, {
    accountId: row.accountId,
    type: 'column.type_changed',
    actorId: a.user.id,
    requestId: a.requestId ?? null,
    boardId: column.boardId,
    columnId: column.id,
    before: { type: row.toType },
    after: { type: row.fromType, settings: row.fromSettings },
    meta: {
      conversion_id: row.id,
      column_key: column.key,
      column_type: row.fromType,
      from_type: row.toType,
      undo_of: undoOf,
    },
  });
  await recordAudit(tx, {
    accountId: row.accountId,
    actorId: a.user.id,
    action: 'column.type_change_undone',
    targetType: 'column',
    targetId: column.id,
    payload: { board_id: column.boardId, key: column.key, conversion_id: row.id },
  });
  return eventId;
};

/** Cells changed since the conversion wrote them (an undo asks before overwriting them). */
export const conversionChanged = async (db: Db, accountId: string, conversionId: string) => {
  const row = await findConversion(db, accountId, conversionId);
  return !!row && (await cellsChangedSince(db, row.columnId, row.id)) > 0;
};

const loadConversion = async (db: Db, a: Actor, boardId: string, conversionId: string) => {
  const row = await findConversion(db, a.ctx.accountId, conversionId);
  if (!row || row.boardId !== boardId) throw new AppError('not_found', 'Conversion not found');
  return row;
};

/**
 * "Restore from backup" (after the undo window, plan §7): back to the original type, a new conversion of its own
 * (with its own backup — so it can be undone too). Cells nobody changed since get their original values; cells
 * changed or added since are converted back through the same rules (with `force`, changed ones get their original
 * values too). Preview with `dry_run`; the restore needs its fingerprint.
 */
export const restoreConversion = async (
  db: Db,
  a: Actor,
  boardId: string,
  conversionId: string,
  input: { dry_run?: boolean; fingerprint?: string; force?: boolean },
) => {
  const source = await loadConversion(db, a, boardId, conversionId);
  const { access, column } = await loadTarget(db, a, boardId, (await findColumnById(db, source.columnId))?.key ?? '');
  if (column.convertingId) throw new AppError('column_converting', 'The column is being converted');
  if (source.status !== 'done') throw new AppError('not_undoable', 'not_done');
  if (source.backupPurgedAt) throw new AppError('not_undoable', 'backup_purged');
  const latest = await latestDoneConversion(db, column.id);
  if (latest?.id !== source.id || column.type !== source.toType)
    throw new AppError('not_undoable', 'later_conversion', { conversion_id: latest?.id });

  const env = await envOf(db, a.ctx.accountId);
  const back = resumeConversion({
    from: { type: column.type, settings: column.settings },
    to: { type: source.fromType, settings: source.fromSettings },
    options: {},
    env,
  });
  const originals = new Map<string, { old: unknown; new: unknown; oldText: string | null }>();
  for (let after: string | null = null; ;) {
    const page = await backupPage(db, source.id, after, 5000);
    for (const r of page) originals.set(r.itemId, { old: r.oldValue, new: r.newValue, oldText: r.oldText });
    if (page.length < 5000) break;
    after = page.at(-1)!.itemId;
  }
  const current = await allCells(db, column.id);
  const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const ctx = keyCtx(env);
  const tagIds = new Map((env.tags ?? []).map((t) => [t.name.trim().toLowerCase(), t.id]));
  const fromDef = columnTypes.get(source.fromType)!;
  const rows: BackupCell[] = [];
  let changed = 0;
  const seen = new Set<string>();
  const original = (cell: StoredCell | null, itemId: string, value: unknown): BackupCell => {
    const keys = value === null ? null : deriveValues(fromDef, source.fromSettings, value, ctx);
    return {
      itemId,
      outcome: value === null ? 'empty' : 'converted',
      partial: false,
      oldValue: cell?.value ?? null,
      oldText: cell?.textValue ?? null,
      oldNumber: cell?.numberValue ?? null,
      oldDate: cell?.dateValue ?? null,
      oldDateEnd: cell?.dateEndValue ?? null,
      newValue: value,
      newText: keys?.textValue ?? null,
      newNumber: keys?.numberValue ?? null,
      newDate: keys?.dateValue ?? null,
      newDateEnd: keys?.dateEndValue ?? null,
    };
  };
  for (const cell of current) {
    seen.add(cell.itemId);
    const o = originals.get(cell.itemId);
    const untouched = o && same(cell.value, o.new);
    if (o && (untouched || input.force)) {
      if (!untouched) changed++;
      rows.push(original(cell, cell.itemId, o.old));
    } else {
      if (o) changed++;
      rows.push(backupRow(cell, convertCell(back, cell.value), back, tagIds, ctx));
    }
  }
  for (const [itemId, o] of originals) {
    if (seen.has(itemId) || o.old === null) continue;
    // Cleared since the conversion (it had a new value) — kept cleared unless forced; failed / empty ones come back.
    if (o.new !== null && !input.force) {
      changed++;
      continue;
    }
    rows.push(original(null, itemId, o.old));
  }
  const itemCount = await countBoardItems(db, column.boardId);
  const converted = rows.filter((r) => r.outcome === 'converted' && r.newValue !== null).length;
  const failed = rows.filter((r) => r.outcome === 'failed').length;
  const counts = {
    items: itemCount,
    converted,
    failed,
    empty: Math.max(0, itemCount - converted - failed),
    partial: 0,
  };
  const fingerprint = fingerprintOf([
    source.id,
    column.updatedAt.toISOString(),
    await lastCellChange(db, column.id),
    current.length,
    itemCount,
    !!input.force,
    counts,
  ]);
  if (input.dry_run || input.fingerprint !== fingerprint) {
    const { dependents } = await scanDependents(db, {
      accountId: a.ctx.accountId,
      board: access.board,
      column,
      to: { type: source.fromType, settings: source.fromSettings },
      conversionId: 'preview',
      apply: false,
      userId: a.user.id,
    });
    const preview = { counts, changed_since: changed, dependents, fingerprint, to_type: source.fromType };
    if (input.dry_run) return { preview };
    throw new AppError(input.fingerprint ? 'preview_stale' : 'validation_failed', 'Preview first', { preview });
  }

  const id = newId();
  await db.transaction(async (tx) => {
    await insertConversion(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId,
      columnId: column.id,
      kind: 'restore',
      restoreOf: source.id,
      fromType: column.type,
      fromSettings: column.settings,
      toType: source.fromType,
      toSettings: source.fromSettings,
      status: 'running',
      total: rows.length,
      itemCount,
      batchId: newId(),
      createdBy: a.user.id,
    });
    await insertBackupCells(tx, a.ctx.accountId, id, rows);
    const row = (await findConversion(tx, a.ctx.accountId, id))!;
    await switchColumn(tx, row, a.requestId ?? null);
  });
  return { conversion: await dtoOf(db, (await findConversion(db, a.ctx.accountId, id))!) };
};

// ---- history, marks, settings ----

const assertReader = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  return access;
};

export const listConversions = async (db: Db, a: Actor, boardId: string, columnKey?: string) => {
  const access = await assertReader(db, a, boardId);
  const column = columnKey ? await findColumnByKey(db, boardId, columnKey) : undefined;
  if (columnKey && !column) throw new AppError('not_found', 'Column not found');
  const rows = await conversionsOfBoard(db, boardId, column?.id);
  const days = await backupDays(db, a.ctx.accountId);
  const out: ColumnConversion[] = [];
  for (const r of rows) {
    const c = column ?? (await findColumnById(db, r.columnId));
    if (!c || !columnAllowed(access, c.restrictedView)) continue;
    out.push(conversionDto(r, c.key, days));
  }
  return { data: out };
};

export const getConversion = async (db: Db, a: Actor, boardId: string, conversionId: string) => {
  const access = await assertReader(db, a, boardId);
  const row = await loadConversion(db, a, boardId, conversionId);
  const column = await findColumnById(db, row.columnId);
  if (!column || !columnAllowed(access, column.restrictedView)) throw new AppError('not_found', 'Conversion not found');
  return conversionDto(row, column.key, await backupDays(db, a.ctx.accountId));
};

/**
 * The failed cells of the board's conversions still marked (for the cell marks — "the original value: …" — and
 * the "failed in conversion" filter): only columns and items the reader may see.
 */
export const failedConversionCells = async (db: Db, a: Actor, boardId: string) => {
  const access = await assertReader(db, a, boardId);
  const days = (await backupDays(db, a.ctx.accountId)) || 3650;
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await failedCells(db, boardId, since);
  if (!rows.length) return { data: [] };
  const visible = new Set(
    (
      await filterVisible(
        db,
        await boardVisibility(db, a, access),
        (await itemsByIds(db, a.ctx.accountId, [...new Set(rows.map((r) => r.itemId))])).filter((i) => !i.deletedAt),
      )
    ).map((i) => i.id),
  );
  const byConversion = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!visible.has(r.itemId)) continue;
    const text = r.oldText ?? (typeof r.oldValue === 'string' ? r.oldValue : JSON.stringify(r.oldValue));
    const m = byConversion.get(r.conversionId) ?? {};
    m[r.itemId] = text ?? '';
    byConversion.set(r.conversionId, m);
  }
  const data = [];
  for (const [id, items] of byConversion) {
    const conv = (await findConversion(db, a.ctx.accountId, id))!;
    const column = await findColumnById(db, conv.columnId);
    if (!column || column.deletedAt || !columnAllowed(access, column.restrictedView)) continue;
    data.push({
      conversion_id: id,
      column_id: column.key,
      from_type: conv.fromType,
      to_type: conv.toType,
      created_at: conv.createdAt.toISOString(),
      items,
    });
  }
  return { data };
};

/** "ניקוי הסימון": the failed cells of a conversion stop being marked (the backup stays). */
export const clearFailedMarks = async (db: Db, a: Actor, boardId: string, conversionId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const row = await loadConversion(db, a, boardId, conversionId);
  if (!isOwnerOrAdmin(access) && row.createdBy !== a.user.id) throw new AppError('forbidden', 'convert_owners_only');
  await updateConversion(db, row.id, { failedClearedAt: new Date() });
  return { ok: true as const };
};

export const conversionSettings = async (db: Db, a: Actor): Promise<ConversionSettings> => ({
  backup_days: (await backupDays(db, a.ctx.accountId)) as ConversionSettings['backup_days'],
});

/** How long the original values are kept (admins; plan §10). */
export const setConversionSettings = async (db: Db, a: Actor, input: ConversionSettings) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admins_only');
  const settings = (await getAccountSettings(db, a.ctx.accountId)) as Record<string, unknown>;
  await upsertAccountSettings(
    db,
    a.ctx.accountId,
    { ...settings, conversions: { backup_days: input.backup_days } },
    a.user.id,
  );
  await recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'conversions.settings_changed',
    payload: { backup_days: input.backup_days },
  });
  return conversionSettings(db, a);
};

/** A conversion that has been `running` this long was interrupted (the process died mid-run). */
export const STALE_CONVERSION_MS = 2 * 60 * 60_000;

/**
 * Conversions interrupted by a crash stayed `running` with the column locked (`converting_id`) for good: every edit
 * of the column answered `column_converting` until someone fixed the row by hand (audit 2026-10-10 C7). The sweep
 * (every ten minutes, `column.convert_sweep`) fails them the way a thrown error does: backup rows dropped, the row
 * failed with `error: stale`, the column unlocked — nothing of the column changed. Returns the conversion ids.
 */
export const sweepStaleConversions = async (db: Db, now = new Date()) => {
  const swept: string[] = [];
  for (const row of await staleRunningConversions(db, new Date(now.getTime() - STALE_CONVERSION_MS))) {
    await db.transaction(async (tx) => {
      await deleteBackupRows(tx, row.id, (await backupItemIds(tx, row.id)) ?? []);
      await updateConversion(tx, row.id, { status: 'failed', error: 'stale', finishedAt: now });
      await setColumnConverting(tx, row.columnId, null);
    });
    swept.push(row.id);
  }
  return swept;
};
