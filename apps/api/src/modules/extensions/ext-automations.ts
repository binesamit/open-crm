// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, blockKey, type ExtAutomation } from '@bines/shared';
import type { Db } from '../../db/client';
import { automations } from '../../db/schema';
import { readableBoardIds } from '../boards/boards.access';
import { liveInstallation } from './ext-token';
import type { ExtActor } from './ext-storage';

/** The most rows one answer names (a page shows its buttons' state, never a report). */
const LIST_MAX = 500;

/**
 * GET /ext/automations?trigger=<key> — a page asks which automations use one of its own triggers
 * (e.g. which of its buttons has a live automation). Read only: its own `automation_trigger` keys (anything else is
 * 404), its page token only, and only automations on the boards its token reads that this member reads. Turning one
 * on / off or editing it stays in the app (the automations routes are never for an extension).
 */
export const listExtAutomations = async (db: Db, a: ExtActor, trigger: string): Promise<{ data: ExtAutomation[] }> => {
  const ext = a.token?.ext;
  if (!ext || ext.server) throw new AppError('forbidden', 'page_token_only');
  const live = await liveInstallation(db, ext.installationId, a.ctx.accountId);
  if (!live) throw new AppError('not_found', 'Extension not found');
  const f = live.manifest.features.find((x) => x.key === trigger);
  if (!f || f.type !== 'automation_trigger') throw new AppError('not_found', 'Trigger not found');
  const boards = [...(await readableBoardIds(db, a.ctx, a.user, a.token?.boardIds ?? []))];
  if (!boards.length) return { data: [] };
  const rows = await db
    .select({
      id: automations.id,
      boardId: automations.boardId,
      title: automations.title,
      isActive: automations.isActive,
      recipe: automations.recipe,
    })
    .from(automations)
    .where(
      and(
        eq(automations.accountId, a.ctx.accountId),
        inArray(automations.boardId, boards),
        isNull(automations.deletedAt),
        sql`${automations.recipe}->'trigger'->>'type' = 'extension_trigger'`,
        sql`${automations.recipe}->'trigger'->>'block' = ${blockKey(live.row.key, f.key)}`,
      ),
    )
    .orderBy(asc(automations.createdAt), asc(automations.id))
    .limit(LIST_MAX);
  return {
    data: rows.map((r) => ({
      id: r.id,
      board_id: r.boardId,
      name: r.title,
      active: r.isActive,
      trigger: r.recipe.trigger,
    })),
  };
};
