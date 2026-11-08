// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  AI_EACH_PHOTOS_MAX,
  type AiColumnSettings,
  type AiImageRerunMode,
  type AiOutput,
  aiOutputMissing,
  aiOutputStatus,
  aiColumnSettingsSchema,
  aiOutputsOf,
  type AiValue,
  AppError,
  buildAiImagePrompt,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { cells } from '../../db/schema';
import { enqueueJob, jobKeyLive } from '../../lib/jobs';
import type { AppDeps } from '../../types';
import { loadAiSettings } from '../ai/ai.service';
import { generateImages, resolveFidelityBase, type SourceImageRef, storeImages } from '../ai/images.service';
import { aiRetryClock, retryDelayMs, retryOf, UNIT_RETRY } from '../ai/retry';
import type { BoardAccess } from '../boards/boards.access';
import { type ColumnRow, listColumns } from '../boards/boards.repo';
import { cellFileAssets } from '../files/files.repo';
import { attachToCell, loadFileColumn } from '../files/files.service';
import { addFileVersion } from '../files/files.versions';
import { itemCells } from '../items/items.repo';
import { type Actor, loadItem, writeCell } from '../items/items.service';
import { type AiColumnRunRow, addColumnUsage, columnMonthUsd, findColumnRunById, updateColumnRun } from './ai2.repo';
import { loadCellInputs, month } from './cell-inputs';
import { inAiScope, personActor } from './context';

/**
 * The AI images queue ("the system doesn't create all my images… there should be a loop that runs
 * and waits to send each image"). An AI column with image output never makes its images inside a request: a run
 * first PLANS every cell — one design per source photo × variation (`each`), or per variation (`together`) — and
 * writes them on the AI cell as `pending` (`ai.outputs`, `ai.run_id`); then ONE job per design
 * (`ai.image_unit`, payload: run, item, source photo, variation) makes them one after the other: each job makes its
 * design, saves its file right away (a new file, or a new version — round 4's rules) and queues the next. A busy /
 * slow / unavailable provider is tried again later (`UNIT_RETRY`: backoff with jitter, the provider's Retry-After),
 * a refusal fails that design with its reason; the run's / column's dollar limits are checked before every design
 * and, when reached, the designs left are marked failed (`limit_run_usd` / `limit_month_usd`) — never dropped. What
 * failed (or was left pending by a run that died) is made later by "complete the missing images" (`only_missing`),
 * which never makes — or charges — a design again.
 *
 * Sequential per run (one job per run at a time, graphile `job_key`), at most `images.concurrency` runs of an
 * account side by side (graphile named queues, one per slot). Without the job runner (tests, a worker-less dev
 * server) the same steps run here, one after the other, waiting between tries with `aiRetryClock`.
 */
type Deps = AppDeps;

export const IMAGE_UNIT_TASK = 'ai.image_unit';
/** A design's job locked longer than this is taken for dead (a provider call times out after 10 minutes). */
const STALE_JOB_MS = 15 * 60_000;

export const imageUnitSchema = z.object({
  run_id: z.string().min(1),
  item_id: z.string().min(1),
  /** The source photo's file id; null = all photos together / none. */
  source: z.string().nullable(),
  variation: z.number().int().min(1),
});
export type ImageUnit = z.infer<typeof imageUnitSchema>;

/** One run's jobs share this key: at most one waits or runs (the run's designs go one after the other). */
export const imageRunJobKey = (runId: string) => `ai.image:${runId}`;

/** A run still making designs: queued / running with a live job (planning included). */
export const imageRunLive = async (db: Db, run: AiColumnRunRow | undefined) =>
  !!run &&
  (run.status === 'queued' || run.status === 'running') &&
  (await jobKeyLive(db, imageRunJobKey(run.id), STALE_JOB_MS));

const sameUnit = (o: AiOutput, source: string | null, variation: number) =>
  (o.source_asset_id ?? null) === source && o.variation === variation;

const isOpen = (o: AiOutput) => {
  const st = aiOutputStatus(o);
  return st === 'pending' || st === 'running';
};

/** A design waiting its turn again (failed / left pending): its error and tries cleared, its file (to version) kept. */
const pendingOf = (o: AiOutput): AiOutput => {
  const { error: _e, retry_at: _r, attempts: _a, ...rest } = o;
  return { ...rest, status: 'pending' };
};

/** The designs a cell makes: one per source photo (`each`, the newest `AI_EACH_PHOTOS_MAX`) × variation. */
export const imageUnitKeys = (s: AiColumnSettings, sources: SourceImageRef[]) => {
  const photos = s.photo_mode === 'each' && sources.length ? sources.slice(-AI_EACH_PHOTOS_MAX) : [null];
  const out: { source: string | null; variation: number }[] = [];
  for (const p of photos)
    for (let v = 1; v <= s.variations; v++) out.push({ source: p ? (p.fileId ?? null) : null, variation: v });
  return out;
};

/** The AI cell's value from its designs: their names as text, the first file, the cost, model and photos counts. */
const cellValueOf = (
  s: AiColumnSettings,
  prev: AiValue['ai'] | null | undefined,
  outputs: AiOutput[],
  patch: { runId: string; costUsd: number; model: string; note?: string | null },
): AiValue => {
  const files = outputs.filter((o) => o.file_id && !o.rejected);
  const done = outputs.filter((o) => aiOutputStatus(o) === 'done' && o.file_id);
  const photos = done.filter((o) => o.source_images);
  const sum = photos.length
    ? photos.reduce(
        (n, o) => ({
          sent: n.sent + o.source_images!.sent,
          total: n.total + o.source_images!.total,
          ...(o.source_images!.examples !== undefined || n.examples !== undefined
            ? { examples: (n.examples ?? 0) + (o.source_images!.examples ?? 0) }
            : {}),
        }),
        { sent: 0, total: 0 } as { sent: number; total: number; examples?: number },
      )
    : null;
  const note = patch.note === undefined ? prev?.note : patch.note;
  return {
    text: files
      .map((o) => o.name ?? '')
      .filter(Boolean)
      .join(', ')
      .slice(0, 20_000),
    ...(files[0]?.file_id ? { file_id: files[0].file_id } : {}),
    ai: {
      at: new Date().toISOString(),
      model: patch.model,
      cost_usd: patch.costUsd,
      kind: s.kind,
      output: 'image',
      ...(sum ? { source_images: sum } : {}),
      outputs,
      ...(done.length > 1 ? { calls: done.length } : {}),
      ...(note ? { note } : {}),
      run_id: patch.runId,
    },
  };
};

/** Writes the AI cell as the run's person, in the run's batch (one undo for the whole run). */
const writeImageCell = (
  deps: Deps,
  a: Actor,
  access: BoardAccess,
  item: Parameters<typeof writeCell>[3],
  column: ColumnRow,
  run: AiColumnRunRow,
  value: AiValue,
) =>
  inAiScope(deps.db, { source: 'column', batch_id: run.batchId!, column_id: column.key, run_id: run.id }, (tx) =>
    writeCell(tx, a, access, item, column, value, run.batchId, { ai_run: run.id }),
  );

/** A passing state of one design (running / waiting to try again): stored as is, no activity row (not undoable). */
const setOutput = async (db: Db, itemId: string, columnId: string, value: AiValue, i: number, o: AiOutput) => {
  const outputs = [...aiOutputsOf(value)];
  outputs[i] = o;
  await db
    .update(cells)
    .set({ value: { ...value, ai: { ...value.ai!, outputs } } })
    .where(and(eq(cells.itemId, itemId), eq(cells.columnId, columnId)));
};

const cellValue = async (db: Db, itemId: string, columnId: string) =>
  ((await itemCells(db, itemId)).find((c) => c.columnId === columnId)?.value ?? null) as AiValue | null;

// ---- planning ----

export type PlanResult = { units: number; error?: string | null; skipped?: boolean };

/**
 * Plans one cell of a run: its designs, `pending`, on the AI cell (as the person who runs it — their rights now, the
 * output column's edit rights before anything is planned). A fresh run plans every design (a design to version
 * keeps its file — round 4's `version`: the same photo + variation, still in the output column, not rejected);
 * `onlyMissing` takes only the designs not made (failed, or pending with no live run) and leaves the made ones as
 * they are. A cell whose designs are being made by a live run is not planned again (`ai_run_in_progress`).
 */
export const planImageCell = async (
  deps: Deps,
  a: Actor,
  column: ColumnRow,
  s: AiColumnSettings,
  itemId: string,
  run: AiColumnRunRow,
  opts: { onExisting?: AiImageRerunMode; onlyMissing: boolean },
): Promise<PlanResult> => {
  const { db } = deps;
  const ctx = await loadCellInputs(deps, a, column, s, itemId, run.trigger, false);
  if (!ctx.ok) return ctx.result.skipped ? { units: 0, skipped: true } : { units: 0, error: ctx.result.error };
  const { item, access } = ctx;
  const { column: fileColumn } = await loadFileColumn(db, a, item.id, s.image_column!);
  const previous = (ctx.cells.find((c) => c.columnId === column.id)?.value ?? null) as AiValue | null;
  const before = aiOutputsOf(previous);
  if (
    previous?.ai?.run_id &&
    previous.ai.run_id !== run.id &&
    before.some(isOpen) &&
    (await imageRunLive(db, await findColumnRunById(db, previous.ai.run_id)))
  )
    return { units: 0, error: 'ai_run_in_progress' };

  let outputs: AiOutput[];
  let note: string | null | undefined;
  if (opts.onlyMissing) {
    if (!before.some(aiOutputMissing)) return { units: 0, skipped: true };
    outputs = before.map((o) => (aiOutputMissing(o) ? pendingOf(o) : o));
  } else {
    let fid;
    try {
      fid = await resolveFidelityBase(deps, a, item.id, s.fidelity, s.fidelity_base_column, ctx.examples);
    } catch (err) {
      if (err instanceof AppError && err.message === 'ai_fidelity_base_unavailable')
        return { units: 0, error: 'fidelity_base_unavailable' };
      throw err;
    }
    note = fid.note;
    const onExisting = opts.onExisting ?? s.image_on_rerun;
    const inColumn = new Set((await cellFileAssets(db, item.id, fileColumn.id)).map((r) => r.asset.id));
    const earlier =
      onExisting === 'version' ? before.filter((p) => p.file_id && !p.rejected && inColumn.has(p.file_id)) : [];
    const taken = new Set<string>();
    outputs = imageUnitKeys(s, ctx.sources).map((k): AiOutput => {
      const prev = earlier.find((p) => !taken.has(p.file_id!) && sameUnit(p, k.source, k.variation));
      if (prev) taken.add(prev.file_id!);
      return {
        ...(prev ? { file_id: prev.file_id, ...(prev.name ? { name: prev.name } : {}) } : {}),
        ...(prev?.version ? { version: prev.version } : {}),
        source_asset_id: k.source,
        variation: k.variation,
        status: 'pending',
      };
    });
  }
  const value = cellValueOf(s, previous?.ai, outputs, {
    runId: run.id,
    costUsd: opts.onlyMissing ? (previous?.ai?.cost_usd ?? 0) : 0,
    model: previous?.ai?.model ?? s.model ?? '',
    ...(note !== undefined ? { note } : {}),
  });
  await writeImageCell(deps, a, access, item, column, run, value);
  return { units: outputs.filter(isOpen).length };
};

// ---- the queue ----

/** The run's next design to make, in the order of its items and of each cell's designs; null = none left. */
const nextUnit = async (db: Db, run: AiColumnRunRow): Promise<ImageUnit | null> => {
  if (!run.itemIds.length) return null;
  const rows = await db
    .select({ itemId: cells.itemId, value: cells.value })
    .from(cells)
    .where(and(eq(cells.columnId, run.columnId), inArray(cells.itemId, run.itemIds)));
  const byItem = new Map(rows.map((r) => [r.itemId, r.value as AiValue]));
  for (const itemId of run.itemIds) {
    const v = byItem.get(itemId);
    if (v?.ai?.run_id !== run.id) continue;
    const o = aiOutputsOf(v).find(isOpen);
    if (o) return { run_id: run.id, item_id: itemId, source: o.source_asset_id ?? null, variation: o.variation };
  }
  return null;
};

/** The run ends: done when something was made or nothing failed; failed when nothing was made and it failed / stopped. */
const finishRun = async (db: Db, runId: string) => {
  const run = (await findColumnRunById(db, runId))!;
  await updateColumnRun(db, run.id, {
    status: run.done === 0 && (run.failed > 0 || (run.stopped && run.stopped !== 'limit_items')) ? 'failed' : 'done',
    finishedAt: new Date(),
  });
};

/**
 * A limit (or the budget, AI turned off …) ends the run: every design it had left is marked failed with the reason
 * — said on the cell, made later with "complete the missing images" — and the run stops with `stopped`.
 */
const stopRun = async (
  deps: Deps,
  a: Actor | null,
  run: AiColumnRunRow,
  column: ColumnRow,
  s: AiColumnSettings,
  reason: string,
  stopped: string,
) => {
  const { db } = deps;
  let failed = 0;
  const errors = [...run.errors];
  for (const itemId of run.itemIds) {
    const v = await cellValue(db, itemId, column.id);
    if (v?.ai?.run_id !== run.id || !aiOutputsOf(v).some(isOpen)) continue;
    const outputs = aiOutputsOf(v).map((o): AiOutput => {
      if (!isOpen(o)) return o;
      failed += 1;
      const { retry_at: _r, ...rest } = o;
      return { ...rest, status: 'failed', error: reason };
    });
    errors.push({ item_id: itemId, error: reason });
    const value = cellValueOf(s, v.ai, outputs, { runId: run.id, costUsd: v.ai.cost_usd, model: v.ai.model });
    try {
      if (!a) throw new AppError('forbidden', 'ai_actor_inactive');
      const { item, access } = await loadItem(db, a, itemId);
      await writeImageCell(deps, a, access, item, column, run, value);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // The person may no longer write there: the marks are stored as is (the cell says what was not made).
      await db
        .update(cells)
        .set({ value })
        .where(and(eq(cells.itemId, itemId), eq(cells.columnId, column.id)));
    }
  }
  await updateColumnRun(db, run.id, { failed: run.failed + failed, errors: errors.slice(-200), stopped });
  await finishRun(db, run.id);
};

/** Errors that end the whole run (the designs left would fail the same way). */
const FATAL = new Set(['ai_disabled', 'ai_budget_exceeded', 'ai_actor_inactive', 'Account is suspended']);
const PLAN_STOPS = new Set(['plan_limit_reached', 'plan_feature_unavailable']);

/** The reason a design failed, as the cell and the run say it. */
const failCode = (err: unknown) => {
  if (!(err instanceof AppError)) return 'internal';
  if (PLAN_STOPS.has(err.code)) return err.code;
  if (err.code === 'forbidden' || err.code === 'not_found')
    return FATAL.has(err.message) ? err.message : 'item_unavailable';
  return err.message;
};

/** What comes next: a design (null = the run ended); a retry says when (`runAt`, after `delayMs`). */
export type StepResult = { next: ImageUnit | null; runAt?: Date; delayMs?: number };

/**
 * One design: checks the run's limits, makes it (one provider call, through the account's checks and budget), saves
 * its file right away and marks it `done` — or waits to try again (a busy / slow provider: `pending` with `error`
 * and `retry_at`, the same design next) — or marks it `failed` with the reason. Answers what comes next.
 */
export const runImageUnit = async (deps: Deps, u: ImageUnit): Promise<StepResult> => {
  const { db } = deps;
  const run = await findColumnRunById(db, u.run_id);
  if (!run || run.status === 'done' || run.status === 'failed') return { next: null };
  const column = (await listColumns(db, run.boardId)).find((c) => c.id === run.columnId && c.type === 'ai');
  if (!column) {
    await updateColumnRun(db, run.id, { status: 'failed', stopped: 'column_deleted', finishedAt: new Date() });
    return { next: null };
  }
  const s = aiColumnSettingsSchema.parse(column.settings ?? {});
  const advance = async (): Promise<StepResult> => {
    const fresh = (await findColumnRunById(db, run.id))!;
    const next = await nextUnit(db, fresh);
    if (!next) await finishRun(db, run.id);
    return { next };
  };
  let a: Actor;
  try {
    a = await personActor(db, run.accountId, run.requestedBy ?? '', `ai-column:${run.id}`, {
      boardLimit: run.boardLimit,
      tokenScopes: run.tokenScopes,
    });
  } catch (err) {
    const code = err instanceof AppError ? err.message : 'internal';
    await stopRun(deps, null, run, column, s, code, code);
    return { next: null };
  }
  const value = await cellValue(db, u.item_id, column.id);
  const outputs = aiOutputsOf(value);
  const i = outputs.findIndex((o) => sameUnit(o, u.source, u.variation));
  // Another run took the cell over, or the design is no longer waiting: on to the next one.
  if (value?.ai?.run_id !== run.id || i < 0 || !isOpen(outputs[i]!)) return advance();

  // The run's / column's limits before every design.
  if (run.costUsd >= s.max_usd_per_run) {
    await stopRun(deps, a, run, column, s, 'limit_run_usd', 'limit_run_usd');
    return { next: null };
  }
  if (
    s.max_usd_per_month !== null &&
    (await columnMonthUsd(db, run.accountId, column.id, month())) >= s.max_usd_per_month
  ) {
    await stopRun(deps, a, run, column, s, 'limit_month_usd', 'limit_column_usd');
    return { next: null };
  }

  const unit = outputs[i]!;
  const attempts = (unit.attempts ?? 0) + 1;
  const { error: _e, retry_at: _r, ...clean } = unit;
  await setOutput(db, u.item_id, column.id, value!, i, { ...clean, status: 'running', attempts });

  const failUnit = async (code: string) => {
    const now = (await cellValue(db, u.item_id, column.id)) ?? value!;
    const list = [...aiOutputsOf(now)];
    const j = list.findIndex((o) => sameUnit(o, u.source, u.variation));
    if (j >= 0) list[j] = { ...clean, status: 'failed', error: code, attempts };
    const next = cellValueOf(s, now.ai, list, {
      runId: run.id,
      costUsd: now.ai?.cost_usd ?? 0,
      model: now.ai?.model ?? '',
    });
    try {
      const { item, access } = await loadItem(db, a, u.item_id);
      await writeImageCell(deps, a, access, item, column, run, next);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      await db
        .update(cells)
        .set({ value: next })
        .where(and(eq(cells.itemId, u.item_id), eq(cells.columnId, column.id)));
    }
    const fresh = (await findColumnRunById(db, run.id))!;
    await updateColumnRun(db, run.id, {
      failed: fresh.failed + 1,
      errors: [...fresh.errors, { item_id: u.item_id, error: code }].slice(-200),
    });
  };

  let made;
  try {
    made = await makeDesign(deps, a, column, s, run, u);
  } catch (err) {
    const retry = retryOf(err);
    if (retry && attempts < UNIT_RETRY.attempts) {
      const delayMs = retryDelayMs(UNIT_RETRY, attempts, retry.retryAfterMs);
      const at = new Date(aiRetryClock.now() + delayMs);
      await setOutput(db, u.item_id, column.id, value!, i, {
        ...clean,
        status: 'pending',
        attempts,
        error: retry.reason,
        retry_at: at.toISOString(),
      });
      return { next: u, runAt: at, delayMs };
    }
    if (!(err instanceof AppError) && !retry) deps.logger.error({ err, runId: run.id }, 'ai image design failed');
    const code = retry ? retry.reason : failCode(err);
    if (FATAL.has(code) || PLAN_STOPS.has(code)) {
      await setOutput(db, u.item_id, column.id, value!, i, { ...clean, status: 'pending', attempts });
      await stopRun(deps, a, (await findColumnRunById(db, run.id))!, column, s, code, code);
      return { next: null };
    }
    await failUnit(code);
    return advance();
  }
  if ('error' in made) {
    await failUnit(made.error);
    return advance();
  }
  await addColumnUsage(db, { accountId: run.accountId, columnId: column.id, month: month(), costUsd: made.costUsd });
  const fresh = (await findColumnRunById(db, run.id))!;
  await updateColumnRun(db, run.id, { done: fresh.done + 1, costUsd: fresh.costUsd + made.costUsd });
  return advance();
};

/**
 * Makes one design and saves it: the cell's inputs read again (the rights of now), its photo (`each`) or all
 * (`together`), the fidelity base, ONE provider call (`generateImages` — AI on, the plan, the budget, `ai_usage`),
 * the file stored and attached (or added as a new version of the design it re-makes), the cell's design `done`.
 * `{ error }` = this design cannot be made (its reason); provider errors are thrown (the caller retries or fails).
 */
const makeDesign = async (
  deps: Deps,
  a: Actor,
  column: ColumnRow,
  s: AiColumnSettings,
  run: AiColumnRunRow,
  u: ImageUnit,
): Promise<{ error: string } | { costUsd: number }> => {
  const { db } = deps;
  const ctx = await loadCellInputs(deps, a, column, s, u.item_id, run.trigger, false);
  if (!ctx.ok) return { error: ctx.result.error ?? 'item_unavailable' };
  const { item, access } = ctx;
  const sources = u.source ? ctx.sources.filter((p) => p.fileId === u.source) : ctx.sources;
  if (u.source && !sources.length) return { error: 'source_gone' };
  // The output column's own rights (item.update, its edit restriction) before anything is spent.
  const { column: fileColumn } = await loadFileColumn(db, a, item.id, s.image_column!);
  let fid;
  try {
    fid = await resolveFidelityBase(deps, a, item.id, s.fidelity, s.fidelity_base_column, ctx.examples);
  } catch (err) {
    if (err instanceof AppError && err.message === 'ai_fidelity_base_unavailable')
      return { error: 'fidelity_base_unavailable' };
    throw err;
  }
  const description = buildAiImagePrompt(s, {
    name: item.name,
    fields: ctx.inputs.map((c) => ({ title: c.title, text: ctx.dto.cells[c.id]?.text ?? '' })),
    updates: [],
    labels: [],
    columns: ctx.refs,
  });
  const r = await generateImages(deps, a.ctx.accountId, {
    prompt: description,
    connectionId: s.connection_id,
    model: s.model,
    size: s.image_size,
    quality: s.image_quality,
    count: 1,
    fidelity: fid.fidelity,
    base: fid.base,
    sources,
    ...(ctx.examples.length ? { examples: ctx.examples } : {}),
  });
  const [file] = await storeImages(deps, a, r.images.slice(0, 1), description);
  // The cell as it is now (a design may have been rejected meanwhile; another run may have taken it over).
  const now = await cellValue(db, item.id, column.id);
  const list = [...aiOutputsOf(now)];
  const j = list.findIndex((o) => sameUnit(o, u.source, u.variation));
  if (now?.ai?.run_id !== run.id || j < 0) return { costUsd: r.costUsd };
  const unit = list[j]!;
  const inColumn = new Set((await cellFileAssets(db, item.id, fileColumn.id)).map((x) => x.asset.id));
  const root = unit.file_id && !unit.rejected && inColumn.has(unit.file_id) ? unit.file_id : null;
  await inAiScope(
    db,
    { source: 'column', batch_id: run.batchId!, column_id: column.key, run_id: run.id },
    async (tx) => {
      if (!root) await attachToCell({ ...deps, db: tx }, a, item.id, s.image_column!, [file!.id]);
      // A new version of the earlier design (files.versions: the cell keeps the file, at its new current version).
      const version = root ? (await addFileVersion({ ...deps, db: tx }, a, root, file!.id)).version : null;
      list[j] = {
        file_id: root ?? file!.id,
        name: file!.name,
        source_asset_id: u.source,
        variation: u.variation,
        ...(version ? { version } : {}),
        ...(r.sourceImages ? { source_images: r.sourceImages } : {}),
        status: 'done',
        attempts: unit.attempts ?? 1,
      };
      const value = cellValueOf(s, now.ai, list, {
        runId: run.id,
        costUsd: (now.ai?.cost_usd ?? 0) + r.costUsd,
        model: r.model,
      });
      await writeCell(tx, a, access, item, column, value, run.batchId, { ai_run: run.id });
    },
  );
  return { costUsd: r.costUsd };
};

/** Queues a design's job: the run's key (one at a time), the account's slot (`images.concurrency` side by side). */
export const queueImageUnit = async (db: Db, run: AiColumnRunRow, u: ImageUnit, runAt?: Date) => {
  const n = (await loadAiSettings(db, run.accountId)).images.concurrency;
  let h = 0;
  for (const ch of run.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return enqueueJob(db, IMAGE_UNIT_TASK, u, {
    ...(runAt ? { runAt } : {}),
    maxAttempts: 3,
    queueName: `ai.images:${run.accountId}:${n > 1 ? h % n : 0}`,
    jobKey: imageRunJobKey(run.id),
  });
};

/** Without the job runner: the run's designs one after the other, here, waiting before each retry. */
const drainImageRun = async (deps: Deps, first: ImageUnit) => {
  let step: StepResult = { next: first };
  while (step.next) {
    if (step.delayMs) await aiRetryClock.sleep(step.delayMs);
    step = await runImageUnit(deps, step.next);
  }
};

/** `ai.image_unit`: one design, then the next one queued (after its wait when it is a retry). */
export const imageUnitJob = async (deps: Deps, u: ImageUnit) => {
  const step = await runImageUnit(deps, u);
  if (!step.next) return;
  const run = await findColumnRunById(deps.db, u.run_id);
  if (run && !(await queueImageUnit(deps.db, run, step.next, step.runAt))) await drainImageRun(deps, step.next);
};

/**
 * A planned run starts making its designs: its first job queued (or, without the runner, all of them here). `stop`:
 * the planning itself was stopped (AI off, the budget …) — what was planned is marked as not made, with that reason.
 */
export const startImageRun = async (deps: Deps, runId: string, stop?: { a: Actor; code: string }) => {
  const run = (await findColumnRunById(deps.db, runId))!;
  if (stop) {
    const column = (await listColumns(deps.db, run.boardId)).find((c) => c.id === run.columnId);
    if (column)
      await stopRun(
        deps,
        stop.a,
        run,
        column,
        aiColumnSettingsSchema.parse(column.settings ?? {}),
        stop.code,
        stop.code,
      );
    else await finishRun(deps.db, runId);
    return;
  }
  const first = await nextUnit(deps.db, run);
  if (!first) {
    await finishRun(deps.db, runId);
    return;
  }
  if (await queueImageUnit(deps.db, run, first)) return;
  await drainImageRun(deps, first);
};
