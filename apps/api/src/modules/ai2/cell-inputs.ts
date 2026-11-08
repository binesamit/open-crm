// SPDX-License-Identifier: AGPL-3.0-only
import { type AiColumnSettings, aiInputColumns, AppError, scopeAllows } from '@bines/shared';
import type { AppDeps } from '../../types';
import { listSourceImages, listStyleExamples, type SourceImageRef } from '../ai/images.service';
import { type ColumnRow, listColumns } from '../boards/boards.repo';
import { itemCells } from '../items/items.repo';
import { type Actor, assertAssigned, calculatorFor, itemDto, loadItem, visibleColumns } from '../items/items.service';
import { listUpdates } from '../updates/updates.service';

/** What one cell of a run came to: spent, written, failed (`error`), skipped, or a limit that ends the run. */
export type FillResult = { cost: number; written: boolean; error: string | null; skipped?: boolean; stopped?: string };

export const month = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Everything one AI cell is made from, read as the person who runs it (their board rights, view_items, column
 * restrictions — an input column they may not see is never sent): the item and its visible columns, the item's
 * data, its latest updates (text output, when asked), the source photos and the style examples
 * (round 3). Or the cell's result when it cannot run (`skipped`: gone / not visible / waiting for a photo; `error`:
 * a source / style column that cannot be read). Shared by text cells and every design of an image cell (each design
 * reads it again when its turn comes — the rights of that moment).
 */
export const loadCellInputs = async (
  deps: Pick<AppDeps, 'db'>,
  a: Actor,
  column: ColumnRow,
  s: AiColumnSettings,
  itemId: string,
  trigger: string,
  withUpdates: boolean,
) => {
  const { db } = deps;
  const fail = (result: FillResult) => ({ ok: false as const, result });
  let item, access;
  try {
    ({ item, access } = await loadItem(db, a, itemId));
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      return fail({ cost: 0, written: false, error: null, skipped: true });
    throw err;
  }
  if (item.boardId !== column.boardId) return fail({ cost: 0, written: false, error: null, skipped: true });
  const all = await listColumns(db, item.boardId);
  const cells = await itemCells(db, item.id);
  assertAssigned(access, a.user, item, cells, all);

  // Never send data the person cannot see: inputs come from the columns visible to them.
  const visible = await visibleColumns(db, access);
  const refs = visible.map((c) => ({ id: c.key, title: c.title, type: c.type }));
  const inputs = aiInputColumns(s, refs, column.key);
  const calc = await calculatorFor(db, a, [item.id]);
  const dto = itemDto(calc, item, visible);
  // S-64: a run asked through a token without `updates:read` sends no updates (now or in the background).
  const updatesAllowed = !a.ctx.tokenScopes || scopeAllows(a.ctx.tokenScopes, 'updates:read');
  const updates =
    withUpdates && s.include_updates && updatesAllowed
      ? (await listUpdates(db, a, item.id))
          .sort((x, y) => y.created_at.localeCompare(x.created_at))
          .slice(0, s.updates_limit)
          .map((u) => u.body_text)
          .filter((t) => t.trim())
      : [];
  // Photos as input: the item's images of the source columns (in their order), as the person may
  // read them — a column hidden from them is never read. None there: made from the description only (`text`, the
  // default), or this cell is not run and nothing is spent (`skip`).
  let sources: SourceImageRef[] = [];
  if (s.source_image_columns.length) {
    if (s.source_image_columns.some((k) => !visible.some((c) => c.key === k)))
      return fail({ cost: 0, written: false, error: 'source_column_unavailable' });
    try {
      sources = await listSourceImages(deps, a, item.id, s.source_image_columns, s.source_image_count);
    } catch (err) {
      if (err instanceof AppError && err.message === 'ai_source_column_unavailable')
        return fail({ cost: 0, written: false, error: 'source_column_unavailable' });
      throw err;
    }
    // `skip`: an auto-run (a new item, a changed input) before a photo is there just waits for one — not a failure.
    if (!sources.length && s.when_no_source_image === 'skip')
      return fail(
        trigger === 'auto'
          ? { cost: 0, written: false, error: null, skipped: true }
          : { cost: 0, written: false, error: 'no_source_image' },
      );
  }
  // Style examples (round 3): the newest images of other items that match the column's filter, as the
  // person may read them (an item or a column hidden from them is left out, never named); none = as without them.
  let examples: SourceImageRef[] = [];
  if (s.style_examples) {
    try {
      examples = await listStyleExamples(deps, a, item, s.style_examples);
    } catch (err) {
      if (err instanceof AppError && /^ai_style_(column_unavailable|filter_invalid)$/.test(err.message))
        return fail({ cost: 0, written: false, error: err.message.replace(/^ai_/, '') });
      throw err;
    }
  }
  return { ok: true as const, item, access, all, cells, visible, refs, inputs, dto, updates, sources, examples };
};
export type CellInputs = Extract<Awaited<ReturnType<typeof loadCellInputs>>, { ok: true }>;
