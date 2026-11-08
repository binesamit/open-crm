// SPDX-License-Identifier: AGPL-3.0-only
import type { AppDeps } from '../../types';
import type { ColumnRow } from '../boards/boards.repo';
import { loadBoardAccess } from '../boards/boards.access';
import type { Actor } from '../items/items.service';
import { findItem } from '../items/items.repo';
import { accountDataKey } from '../secrets/secret-crypto';
import { writeSecretInBatch } from '../secrets/secrets.service';

/** What a submission keeps for a secret answer: only that one was given (the value is on the item, encrypted). */
export const SECRET_ANSWER_MARK = '••••';

/**
 * a form's secret answers onto the item the submission just created — encrypted with the account's key
 * like any secret (the same write as an import: the marker cell, a `secret.changed` event and the `secret.set` audit,
 * "via form"), in the submission's batch. The item is new, so no cell holds a value and no code is asked; the value
 * goes nowhere else (the submission keeps `SECRET_ANSWER_MARK`, notifications and webhooks never see it).
 */
export const writeFormSecrets = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  actor: Actor,
  itemId: string,
  secrets: { column: ColumnRow; value: string }[],
  opts: {
    batchId: string;
    form: { id: string; title: string };
    visitor: { ip: string | null; userAgent: string | null };
  },
) => {
  const { db } = deps;
  const item = await findItem(db, actor.ctx.accountId, itemId);
  if (!item) return;
  const access = await loadBoardAccess(db, actor.ctx, actor.user, item.boardId);
  // Before the transaction: a missing master key fails here, with nothing half written.
  const dataKey = await accountDataKey(db, deps.env, actor.ctx.accountId);
  const meta = { ip: opts.visitor.ip, userAgent: opts.visitor.userAgent, requestId: actor.requestId ?? '' };
  const a = { ...actor, sessionId: null, token: null, meta };
  await db.transaction(async (tx) => {
    for (const s of secrets)
      await writeSecretInBatch(tx, a, dataKey, access, item, s.column, s.value, {
        batchId: opts.batchId,
        replace: false,
        verified: new Set(),
        via: { via: 'form', form_id: opts.form.id, form_title: opts.form.title },
        fresh: true,
      });
  });
};
