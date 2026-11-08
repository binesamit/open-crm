// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { type AiValue, aiOutputsOf } from '@bines/shared';
import type { Db } from '../../db/client';
import { cells } from '../../db/schema';
import { itemCells } from '../items/items.repo';

/**
 * AI designs a person removed (round 4 — "an image I disliked can't be deleted"): when a file leaves
 * a cell for the trash — from the AI cell's ✕ or from the output files column itself — every AI cell of the item that
 * lists it among its designs (`ai.outputs`, or a cell made before round 4 with that `file_id`) marks it `rejected`.
 * The cell then shows "Rejected" for it and a later run never versions it (a new design takes its place). Only the
 * mark changes — the cell's text, cost and model stay; no activity row of its own (the file's removal is the undoable
 * action).
 */
export const markAiOutputsRejected = async (db: Db, itemId: string, fileId: string) => {
  for (const c of await itemCells(db, itemId)) {
    const v = c.value as AiValue | null;
    const outputs = aiOutputsOf(v);
    if (!v?.ai || !outputs.some((o) => o.file_id === fileId && !o.rejected)) continue;
    const value = {
      ...v,
      ai: { ...v.ai, outputs: outputs.map((o) => (o.file_id === fileId ? { ...o, rejected: true } : o)) },
    };
    await db
      .update(cells)
      .set({ value })
      .where(and(eq(cells.itemId, itemId), eq(cells.columnId, c.columnId)));
  }
};
