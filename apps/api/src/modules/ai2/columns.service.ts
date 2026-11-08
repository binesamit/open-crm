// SPDX-License-Identifier: AGPL-3.0-only
import {
  AI_IMAGE_RERUN_MODES,
  type AiImageRerunMode,
  aiOutputsOf,
  type AiColumnInfo,
  type AiColumnRun,
  type AiColumnRunRequest,
  type AiColumnSettings,
  aiColumnSettingsSchema,
  type AiValue,
  aiInputColumns,
  AppError,
  buildAiColumnPrompt,
  cellFromText,
  newId,
  parseAiColumnOutput,
} from '@bines/shared';
import type Anthropic from '@anthropic-ai/sdk';
import { inputImageLimit } from '@bines/server-ai';
import { assertAiStatusAllows, assertFeature } from '../billing/entitlements';
import type { Db } from '../../db/client';
import { enqueueJob } from '../../lib/jobs';
import type { AppDeps } from '../../types';
import { findConnection } from '../ai/ai.repo';
import { completeWith, loadAiSettings } from '../ai/ai.service';
import { readSourceImages, sourceImagesRecord, withLegend } from '../ai/images.service';
import { detachFromCell, loadFileColumn } from '../files/files.service';
import { cellFileAssets } from '../files/files.repo';
import { assertBoard, type BoardAccess, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { type ColumnRow, findColumnById, listColumns } from '../boards/boards.repo';
import { itemCells } from '../items/items.repo';
import { type Actor, listItems, loadItem, writeCell } from '../items/items.service';
import { type FillResult, loadCellInputs, month } from './cell-inputs';
import { imageRunJobKey, planImageCell, startImageRun } from './image-queue';
import {
  type AiColumnRunRow,
  addColumnUsage,
  autoRunColumns,
  claimColumnRun,
  columnMonthUsd,
  findColumnRun,
  findColumnRunById,
  insertColumnRun,
  recentColumnRuns,
  takeDuePending,
  updateColumnRun,
  upsertPending,
} from './ai2.repo';
import { inAiScope, personActor } from './context';
import { markAiOutputsRejected } from './outputs';

/**
 * AI columns (the planning notes "AGENTS-MCP" מ11, D26). A run fills cells of one AI column as the person who asked —
 * their board rights, view_items, column restrictions: an input column they may not see is never sent, an item
 * they may not see is skipped. Each cell is one model call through the column's AI connection + model
 * (`completeWith`: AI on, account budget; the cost lands in ai_usage as source `column`). Limits per run (items,
 * dollars) and per column (dollars a month) stop a run early. Every write of a run is one batch → one undo.
 */
type Deps = AppDeps;

/**
 * A text run of at most this many items answers in the request; bigger runs go to the queue. Image output (prod
 *) is always made by the images queue (`image-queue.ts`) — only the planning of a small run is done here.
 */
export const SYNC_ITEMS = 5;
/** Auto-run waits this long after the last change of an input column. */
export const AUTO_RUN_DEBOUNCE_MS = 5_000;

const runDto = (r: AiColumnRunRow, column: ColumnRow): AiColumnRun => ({
  id: r.id,
  board_id: r.boardId,
  column_id: column.key,
  status: r.status as AiColumnRun['status'],
  trigger: r.trigger as AiColumnRun['trigger'],
  unit: (column.settings as { output?: string } | null)?.output === 'image' ? 'image' : 'cell',
  total: r.total,
  done: r.done,
  failed: r.failed,
  skipped: r.skipped,
  cost_usd: Math.round(r.costUsd * 1_000_000) / 1_000_000,
  stopped: r.stopped,
  batch_id: r.batchId && r.done > 0 ? r.batchId : null,
  errors: r.errors.slice(0, 50),
  created_at: r.createdAt.toISOString(),
  finished_at: r.finishedAt?.toISOString() ?? null,
});

/** The AI column a person may run: visible to them, editable by them; 404 / 403 otherwise. */
const loadAiColumn = async (db: Db, a: Actor, boardId: string, columnKey: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const columns = await listColumns(db, boardId);
  const column = columns.find((c) => c.key === columnKey && c.type === 'ai');
  if (!column || !columnAllowed(access, column.restrictedView)) throw new AppError('not_found', 'Column not found');
  return { access, column, columns };
};

const assertMayRun = (a: Actor, access: BoardAccess, column: ColumnRow) => {
  // AI spends the account's money: never for guests (whatever their board rights).
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'ai_not_for_guests');
  assertBoard(access, 'item.update');
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
};

/** Why the column cannot run now (null = ready). */
const readiness = async (db: Db, accountId: string, s: AiColumnSettings) => {
  const ai = await loadAiSettings(db, accountId);
  if (!ai.enabled) return 'ai_disabled';
  if (!s.connection_id || !(await findConnection(db, accountId, s.connection_id))) return 'not_configured';
  if (s.output === 'image') {
    if (!s.image_column) return 'no_image_column';
    // the source photos and the made images in one column would feed the AI its own pictures.
    return s.source_image_columns.includes(s.image_column) ? 'same_image_columns' : null;
  }
  if (s.kind === 'classify' && !s.labels_from && !s.labels.length) return 'no_labels';
  return null;
};

/** GET /boards/{boardId}/ai-columns/{columnId}: ready?, this month's spend, the latest runs. */
export const aiColumnInfo = async (deps: Pick<Deps, 'db'>, a: Actor, boardId: string, columnKey: string) => {
  const { column } = await loadAiColumn(deps.db, a, boardId, columnKey);
  const s = aiColumnSettingsSchema.parse(column.settings ?? {});
  const reason = await readiness(deps.db, a.ctx.accountId, s);
  const runs = await recentColumnRuns(deps.db, a.ctx.accountId, column.id);
  return {
    ready: reason === null,
    reason,
    month_usd: Math.round((await columnMonthUsd(deps.db, a.ctx.accountId, column.id, month())) * 1_000_000) / 1_000_000,
    max_usd_per_month: s.max_usd_per_month,
    runs: runs.map((r) => runDto(r, column)),
  } satisfies AiColumnInfo;
};

/**
 * POST /boards/{boardId}/ai-columns/{columnId}/run — fills the given items, the empty cells or every cell. Small
 * runs answer right away; larger ones are queued (`ai.column_run`) and polled at GET /ai-columns/runs/{id}.
 */
export const runAiColumn = async (
  deps: Deps,
  a: Actor,
  boardId: string,
  columnKey: string,
  req: AiColumnRunRequest,
  trigger: 'manual' | 'auto' = 'manual',
): Promise<AiColumnRun> => {
  const { db } = deps;
  const { access, column } = await loadAiColumn(db, a, boardId, columnKey);
  assertMayRun(a, access, column);
  // Plans: AI columns are the plan's `ai` (manual and auto runs alike; the column and its values stay).
  await assertFeature(db, a.ctx.accountId, 'ai');
  // plan-lock: no AI in a read-only / suspended / closed account (the status's own error).
  await assertAiStatusAllows(db, a.ctx.accountId);
  const s = aiColumnSettingsSchema.parse(column.settings ?? {});
  const reason = await readiness(db, a.ctx.accountId, s);
  if (reason === 'ai_disabled') throw new AppError('forbidden', 'ai_disabled');
  if (reason) throw new AppError('unprocessable', `ai_column_${reason}`);

  // "Complete the missing images": only an image column has designs to complete.
  if (req.only_missing && s.output !== 'image') throw new AppError('unprocessable', 'ai_column_not_image');

  let ids: string[];
  if (req.mode === 'items') {
    if (!req.item_ids?.length) throw new AppError('validation_failed', 'item_ids is required');
    ids = [...new Set(req.item_ids)];
  } else {
    // Only what the person sees (view_items, board access) — listItems filters.
    const rows = await listItems(db, a, boardId);
    ids = rows.filter((r) => req.mode === 'all' || req.only_missing || !r.cells[column.key]?.text).map((r) => r.id);
  }
  const capped = ids.length > s.max_items_per_run;
  ids = ids.slice(0, s.max_items_per_run);
  const [run] = await insertColumnRun(db, {
    id: newId(),
    accountId: a.ctx.accountId,
    boardId,
    columnId: column.id,
    requestedBy: a.user.id,
    trigger,
    // The run-time re-run choice / "only the missing designs" rides on the mode (`runModeOf`).
    mode: req.only_missing ? `${req.mode}:missing` : req.on_existing ? `${req.mode}:${req.on_existing}` : req.mode,
    itemIds: ids,
    total: ids.length,
    batchId: newId(),
    stopped: capped ? 'limit_items' : null,
    // S-64: a token's run keeps its board limit and scopes when it runs in the background.
    boardLimit: a.ctx.boardLimit ?? null,
    tokenScopes: a.ctx.tokenScopes ?? null,
  });
  // An image run's planning job holds the run's key, so the run counts as live while it plans.
  const key = s.output === 'image' ? { jobKey: imageRunJobKey(run!.id) } : {};
  if (
    ids.length > SYNC_ITEMS &&
    (await enqueueJob(db, 'ai.column_run', { run_id: run!.id }, { maxAttempts: 1, ...key }))
  )
    return runDto(run!, column);
  return runDto(await executeColumnRun(deps, run!.id, a), column);
};

/**
 * POST /boards/{boardId}/ai-columns/{columnId}/items/{itemId}/outputs/{fileId}/reject (round 4): a
 * design the person does not want — taken out of the output column to the trash (restorable; undo puts it back) and
 * marked `rejected` on the AI cell (`markAiOutputsRejected`, the same as removing it from the files column itself).
 * The rights of removing a file there: item.update and the output column's edit restriction. Already gone from the
 * column: only the mark. Not a design of this cell: 404.
 */
export const rejectAiOutput = async (
  deps: Deps,
  a: Actor,
  boardId: string,
  columnKey: string,
  itemId: string,
  fileId: string,
) => {
  const { db } = deps;
  const { column } = await loadAiColumn(db, a, boardId, columnKey);
  const s = aiColumnSettingsSchema.parse(column.settings ?? {});
  const { item } = await loadItem(db, a, itemId);
  if (item.boardId !== column.boardId || !s.image_column) throw new AppError('not_found', 'Design not found');
  const value = (await itemCells(db, item.id)).find((c) => c.columnId === column.id)?.value as AiValue | undefined;
  if (!aiOutputsOf(value).some((o) => o.file_id === fileId)) throw new AppError('not_found', 'Design not found');
  // The output column's own rights (item.update, its edit restriction) — 403 before anything changes.
  const { column: fileColumn } = await loadFileColumn(db, a, item.id, s.image_column);
  if ((await cellFileAssets(db, item.id, fileColumn.id)).some((r) => r.asset.id === fileId))
    await detachFromCell(deps, a, item.id, s.image_column, fileId);
  else await markAiOutputsRejected(db, item.id, fileId);
  return { item_id: item.id, file_id: fileId, rejected: true as const };
};

export const getColumnRun = async (deps: Pick<Deps, 'db'>, a: Actor, runId: string) => {
  const run = await findColumnRun(deps.db, a.ctx.accountId, runId);
  if (!run) throw new AppError('not_found', 'Run not found');
  // Only someone who may see the column sees its runs.
  const access = await loadBoardAccess(deps.db, a.ctx, a.user, run.boardId);
  assertBoard(access, 'item.read');
  const column = (await listColumns(deps.db, run.boardId)).find((c) => c.id === run.columnId);
  if (!column || !columnAllowed(access, column.restrictedView)) throw new AppError('not_found', 'Run not found');
  return runDto(run, column);
};

/**
 * A run's mode with the run-time re-run choice (round 4): `items:version`, `all:add` … — the `mode` column holds
 * both (no migration); a plain mode = the column's own `image_on_rerun`. `items:missing` = only the designs not
 * made yet.
 */
const runModeOf = (mode: string) => {
  const [m, extra] = mode.split(':');
  return {
    mode: m!,
    onExisting: (AI_IMAGE_RERUN_MODES as readonly string[]).includes(extra ?? '')
      ? (extra as AiImageRerunMode)
      : undefined,
    onlyMissing: extra === 'missing',
  };
};

/** The labels a classification may answer: a status / dropdown column's (live ones), or the fixed list. */
const labelsOf = (s: AiColumnSettings, columns: ColumnRow[]) => {
  if (s.labels_from) {
    const col = columns.find((c) => c.key === s.labels_from);
    const labels = ((col?.settings as { labels?: { label: string; is_deactivated?: boolean }[] } | null)?.labels ??
      []) as { label: string; is_deactivated?: boolean }[];
    return labels.filter((l) => !l.is_deactivated && l.label.trim()).map((l) => l.label);
  }
  return s.labels;
};

/** One text cell: read what the person may see → one model call → parse strictly → write (+ the classification target). */
const fillCell = async (
  deps: Deps,
  a: Actor,
  column: ColumnRow,
  s: AiColumnSettings,
  itemId: string,
  run: AiColumnRunRow,
): Promise<FillResult> => {
  const { db } = deps;
  const ctx = await loadCellInputs(deps, a, column, s, itemId, run.trigger, true);
  if (!ctx.ok) return ctx.result;
  const { item, access, all, refs, inputs, dto, updates, sources, examples } = ctx;
  const labels = s.kind === 'classify' ? labelsOf(s, all) : [];
  const prompt = buildAiColumnPrompt(s, {
    name: item.name,
    fields: inputs.map((c) => ({ title: c.title, text: dto.cells[c.id]?.text ?? '' })),
    updates,
    labels,
    columns: refs,
  });

  // Text from photos: the pictures go first, as image blocks, then the item's data — only to a model
  // that sees images (`completeWith` refuses the others before any call: this cell fails with that reason, unpaid).
  // As many as the provider takes in one request (the newest), with a line naming their columns when several; style
  // examples first, with their line.
  const conn = sources.length || examples.length ? await findConnection(db, a.ctx.accountId, s.connection_id!) : null;
  const read = conn
    ? await readSourceImages(deps, sources, inputImageLimit(conn.provider, s.model ?? '', 'vision'), examples)
    : null;
  const images = read?.images ?? [];
  const user = withLegend(prompt.user, read?.legend ?? null);
  const content: string | Anthropic.ContentBlockParam[] = images.length
    ? [
        ...images.map((img): Anthropic.ImageBlockParam => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mime as Anthropic.Base64ImageSource['media_type'],
            data: Buffer.from(img.data).toString('base64'),
          },
        })),
        { type: 'text', text: user },
      ]
    : prompt.user;
  let out;
  try {
    out = await completeWith(deps, a.ctx.accountId, s.connection_id!, 'column', {
      ...(s.model ? { model: s.model } : {}),
      system: prompt.system,
      messages: [{ role: 'user', content }],
      maxTokens: prompt.maxTokens,
      effort: 'low',
    });
  } catch (err) {
    if (err instanceof AppError && err.message === 'ai_model_no_vision')
      return { cost: 0, written: false, error: err.message };
    throw err;
  }
  await addColumnUsage(db, { accountId: a.ctx.accountId, columnId: column.id, month: month(), costUsd: out.costUsd });
  if (out.stopReason === 'refusal') return { cost: out.costUsd, written: false, error: 'refusal' };
  if (out.stopReason === 'max_tokens') return { cost: out.costUsd, written: false, error: 'max_tokens' };
  const parsed = parseAiColumnOutput(s, out.text, labels);
  if (!parsed.ok) return { cost: out.costUsd, written: false, error: parsed.error };

  const value = parsed.value
    ? {
        ...parsed.value,
        ai: {
          at: new Date().toISOString(),
          model: out.model,
          cost_usd: out.costUsd,
          kind: s.kind,
          ...(read ? { source_images: sourceImagesRecord(read, examples.length > 0) } : {}),
        },
      }
    : null;
  const target = s.kind === 'classify' && s.write_to ? all.find((c) => c.key === s.write_to) : undefined;
  await inAiScope(
    db,
    { source: 'column', batch_id: run.batchId!, column_id: column.key, run_id: run.id },
    async (tx) => {
      await writeCell(tx, a, access, item, column, value, run.batchId, { ai_run: run.id });
      // "Classify into a status / dropdown column" as an action: the same label, same batch, the person's rights.
      if (target && value && (target.type === 'status' || target.type === 'dropdown')) {
        const v = cellFromText(target.type, value.text, target.settings, []);
        if (v !== undefined) await writeCell(tx, a, access, item, target, v, run.batchId, { ai_run: run.id });
      }
    },
  );
  return { cost: out.costUsd, written: true, error: null };
};

/** Stops that end a whole run (the rest of the items would fail the same way). */
const FATAL = new Set(['ai_disabled', 'ai_budget_exceeded', 'ai_actor_inactive', 'Account is suspended']);
/** Plans: the plan's AI budget is used up / AI is not in the plan — the rest would fail the same way. */
const planStop = (err: unknown) =>
  err instanceof AppError && (err.code === 'plan_limit_reached' || err.code === 'plan_feature_unavailable')
    ? err.code
    : null;

/** Runs (or continues) a queued run: item by item, within its limits (image output: plans it, then queues it). */
export const executeColumnRun = async (deps: Deps, runId: string, actor?: Actor) => {
  const { db } = deps;
  const claimed = await claimColumnRun(db, runId);
  if (!claimed) return (await findColumnRunById(db, runId))!;
  let run = claimed;
  const patch = async (p: Partial<AiColumnRunRow>) => {
    run = (await updateColumnRun(db, run.id, p))[0]!;
  };
  try {
    const a =
      actor ??
      (await personActor(db, run.accountId, run.requestedBy ?? '', `ai-column:${run.id}`, {
        boardLimit: run.boardLimit,
        tokenScopes: run.tokenScopes,
      }));
    const column = (await listColumns(db, run.boardId)).find((c) => c.id === run.columnId && c.type === 'ai');
    if (!column) {
      await patch({ status: 'failed', stopped: 'column_deleted', finishedAt: new Date() });
      return run;
    }
    const s = aiColumnSettingsSchema.parse(column.settings ?? {});
    if (s.output === 'image') return await planImageRun(deps, a, run, column, s);
    let { done, failed, skipped, costUsd } = run;
    const errors = [...run.errors];
    let stopped = run.stopped;
    for (const itemId of run.itemIds) {
      if (costUsd >= s.max_usd_per_run) {
        stopped = 'limit_run_usd';
        break;
      }
      if (
        s.max_usd_per_month !== null &&
        (await columnMonthUsd(db, run.accountId, column.id, month())) >= s.max_usd_per_month
      ) {
        stopped = 'limit_column_usd';
        break;
      }
      try {
        const r = await fillCell(deps, a, column, s, itemId, run);
        costUsd += r.cost;
        if (r.skipped) skipped += 1;
        else if (r.written) done += 1;
        else {
          failed += 1;
          errors.push({ item_id: itemId, error: r.error ?? 'failed' });
        }
      } catch (err) {
        const code = err instanceof AppError ? err.message : 'internal';
        if (!(err instanceof AppError)) deps.logger.error({ err, runId }, 'ai column cell failed');
        if (FATAL.has(code)) {
          stopped = code;
          break;
        }
        if (planStop(err)) {
          stopped = planStop(err);
          break;
        }
        if (err instanceof AppError && (err.code === 'forbidden' || err.code === 'not_found')) skipped += 1;
        else {
          failed += 1;
          errors.push({ item_id: itemId, error: err instanceof AppError ? err.code : 'internal' });
        }
      }
      await patch({ done, failed, skipped, costUsd, errors });
    }
    await patch({
      status: done === 0 && (failed > 0 || (stopped && stopped !== 'limit_items')) ? 'failed' : 'done',
      done,
      failed,
      skipped,
      costUsd,
      errors,
      stopped,
      finishedAt: new Date(),
    });
  } catch (err) {
    deps.logger.error({ err, runId }, 'ai column run crashed');
    await patch({
      status: 'failed',
      stopped: err instanceof AppError ? err.message : 'internal',
      finishedAt: new Date(),
    });
  }
  return run;
};

/**
 * Image output (the images queue): every item's designs are planned on its AI cell (`pending`), the
 * run's `total` = the designs to make (an item that cannot run counts as one failed), then the queue makes them one
 * after the other (`startImageRun` — jobs; without the job runner, right here). Nothing is made in this step.
 */
const planImageRun = async (deps: Deps, a: Actor, run: AiColumnRunRow, column: ColumnRow, s: AiColumnSettings) => {
  const { db } = deps;
  const { onExisting, onlyMissing } = runModeOf(run.mode);
  let total = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [...run.errors];
  let stopped: string | null = null;
  for (const itemId of run.itemIds) {
    try {
      const r = await planImageCell(deps, a, column, s, itemId, run, { onExisting, onlyMissing });
      total += r.units;
      if (r.skipped) skipped += 1;
      else if (r.error) {
        total += 1;
        failed += 1;
        errors.push({ item_id: itemId, error: r.error });
      }
    } catch (err) {
      const code = err instanceof AppError ? err.message : 'internal';
      if (!(err instanceof AppError)) deps.logger.error({ err, runId: run.id }, 'ai image cell plan failed');
      if (FATAL.has(code) || planStop(err)) {
        stopped = planStop(err) ?? code;
        break;
      }
      if (err instanceof AppError && (err.code === 'forbidden' || err.code === 'not_found')) skipped += 1;
      else {
        total += 1;
        failed += 1;
        errors.push({ item_id: itemId, error: err instanceof AppError ? err.code : 'internal' });
      }
    }
  }
  await updateColumnRun(db, run.id, { total, failed, skipped, errors, ...(stopped ? { stopped } : {}) });
  // A stop while planning: the designs already planned are marked as not made (the cell says why).
  await startImageRun(deps, run.id, stopped ? { a, code: stopped } : undefined);
  return (await findColumnRunById(db, run.id))!;
};

// ---- auto-run ----

type EventRow = {
  accountId: string;
  type: string;
  itemId: string | null;
  actorId: string | null;
  boardId: string | null;
  payload: unknown;
};

/**
 * The token behind an event (S-64): an API token stamps `meta.board_limit` / `meta.token_scopes` (requireAccount),
 * an MCP connection `meta.mcp.board_limit` / `meta.mcp.token_scopes`. null = not limited / a signed-in person.
 */
export const eventTokenLimits = (meta: Record<string, unknown>) => {
  const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
  const mcp = meta.mcp && typeof meta.mcp === 'object' ? (meta.mcp as Record<string, unknown>) : {};
  return {
    boardLimit: list(meta.board_limit) ?? list(mcp.board_limit),
    tokenScopes: list(meta.token_scopes) ?? list(mcp.token_scopes),
  };
};

/**
 * From the dispatch job (every committed event): a change of an AI column's input (a cell, or the name — or a file a
 * person added to its source photos column) puts the item's cell on the debounce list; `runDueAutoCells` runs it once the inputs stop changing. AI writes never
 * trigger an auto-run (no loops between AI columns), nor do changes without a person behind them.
 */
export const scheduleAiColumns = async (deps: Pick<Deps, 'db'>, row: EventRow, now = new Date()) => {
  if (!row.itemId || !row.boardId || !row.actorId) return 0;
  if (!['cell.changed', 'item.renamed', 'item.created', 'file.added'].includes(row.type)) return 0;
  const meta = ((row.payload as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
  if (meta.via === 'ai' || meta.agent || meta.automation || meta.undo_of) return 0;
  const columnKey = typeof meta.column_key === 'string' ? meta.column_key : null;
  const { boardLimit, tokenScopes } = eventTokenLimits(meta);
  const cols = await autoRunColumns(deps.db, row.accountId, row.boardId);
  let n = 0;
  for (const col of cols) {
    const s = aiColumnSettingsSchema.safeParse(col.settings ?? {});
    if (!s.success || !s.data.auto_run) continue;
    const refs = (await listColumns(deps.db, row.boardId)).map((c) => ({ id: c.key, title: c.title, type: c.type }));
    const inputs = aiInputColumns(s.data, refs, col.key).map((c) => c.id);
    // a person adding a file to the source photos column runs it too.
    const hears =
      row.type === 'file.added'
        ? !!columnKey && s.data.source_image_columns.includes(columnKey)
        : row.type === 'cell.changed'
          ? !!columnKey && columnKey !== col.key && inputs.includes(columnKey)
          : row.type === 'item.created' || s.data.include_name;
    if (!hears) continue;
    await upsertPending(deps.db, {
      accountId: row.accountId,
      itemId: row.itemId,
      columnId: col.id,
      actorId: row.actorId,
      boardLimit,
      tokenScopes,
      dueAt: new Date(now.getTime() + AUTO_RUN_DEBOUNCE_MS),
    });
    n += 1;
  }
  if (n)
    await enqueueJob(deps.db, 'ai.column_auto', {}, { runAt: new Date(now.getTime() + AUTO_RUN_DEBOUNCE_MS + 500) });
  return n;
};

/**
 * `ai.column_auto`: the cells whose inputs stopped changing run — one cell each, as the person who changed them
 * last (their rights; nothing when they may no longer edit), within the column's limits and the account budget.
 */
export const runDueAutoCells = async (deps: Deps, now = new Date()) => {
  let n = 0;
  for (const p of await takeDuePending(deps.db, now)) {
    if (!p.actorId) continue;
    try {
      const a = await personActor(deps.db, p.accountId, p.actorId, `ai-auto:${p.itemId}`, {
        boardLimit: p.boardLimit,
        tokenScopes: p.tokenScopes,
      });
      const column = await findColumnById(deps.db, p.columnId);
      if (!column || column.deletedAt || column.accountId !== p.accountId) continue;
      await runAiColumn(deps, a, column.boardId, column.key, { mode: 'items', item_ids: [p.itemId] }, 'auto');
      n += 1;
    } catch (err) {
      // A person without edit rights, AI turned off, the budget used up: nothing runs (and nothing is retried).
      if (!(err instanceof AppError)) deps.logger.warn({ err, itemId: p.itemId }, 'ai auto-run failed');
    }
  }
  return n;
};
