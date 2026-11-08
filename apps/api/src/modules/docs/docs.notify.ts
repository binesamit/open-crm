// SPDX-License-Identifier: AGPL-3.0-only
import type { NotificationType } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { findMembership } from '../accounts/accounts.repo';
import { notifyUsers } from '../notifications/notify';
import { loadDocAccess } from './docs.access';
import type { DocMeta } from './docs.repo';

/**
 * Doc notifications (M8 ד2–ד3) — the updates' rules (`notify` in notifications.service) for a doc: only active
 * members of the account who can read the doc now hear about it (a notification never leaks a doc), never the
 * actor, and each person's bell / email settings decide (`channelAllowed`). A cell doc counts as its board's for
 * per-board settings.
 */
export type DocDraft = {
  type: Extract<NotificationType, 'doc_mention' | 'doc_comment'>;
  doc: Pick<DocMeta, 'id' | 'accountId' | 'name' | 'boardId' | 'itemId'>;
  actorId: string | null;
  excerpt?: string;
  threadId?: string | null;
};

/** Who of `userIds` may read the doc (each with their own account role). */
export const docAudience = async (
  db: Db,
  account: AccountContext['account'],
  docId: string,
  userIds: Iterable<string>,
) => {
  const out: string[] = [];
  for (const id of new Set(userIds)) {
    const m = await findMembership(db, account.id, id);
    if (m?.status !== 'active') continue;
    const ctx: AccountContext = { account, accountId: account.id, role: m.role, membershipId: m.id, boardLimit: null };
    try {
      await loadDocAccess(db, ctx, { id } as SessionUser, docId);
      out.push(id);
    } catch {
      // cannot read the doc: no notification
    }
  }
  return out;
};

export const notifyDoc = async (
  tx: Db,
  account: AccountContext['account'],
  d: DocDraft,
  userIds: Iterable<string>,
): Promise<string[]> => {
  const candidates = [...new Set(userIds)].filter((id) => id !== d.actorId);
  if (!candidates.length) return [];
  return notifyUsers(
    tx,
    {
      accountId: account.id,
      type: d.type,
      actorId: d.actorId,
      boardIds: [d.doc.boardId ?? null],
      // A cell doc's item, so the email names it; the bell opens the doc.
      target: { boardId: d.doc.boardId ?? null, itemId: d.doc.itemId ?? null, docId: d.doc.id },
      payload: {
        doc_name: d.doc.name,
        ...(d.threadId ? { thread_id: d.threadId } : {}),
        ...(d.excerpt ? { excerpt: d.excerpt } : {}),
      },
    },
    await docAudience(tx, account, d.doc.id, candidates),
  );
};
