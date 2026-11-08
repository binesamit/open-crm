// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type DocLevel, type inviteToDocSchema, newId } from '@bines/shared';
import type { z } from 'zod';
import type { AppDeps, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { inviteNewPeople } from '../invitations/invitations.service';
import { assertDoc, canOpenDoc, loadDocAccess } from './docs.access';
import { auditGuestShare, notifyShared } from '../sharing/sharing';
import { docMemberRows, insertDocMembers } from './docs.repo';

/**
 * POST /docs/:id/invite (M8 ד3) — share a doc by email, like a board's invite: people already in the account join
 * the doc at once (at the chosen level, unless already invited); new people get an account invitation that adds
 * them to the doc when they accept. Guests only on a shareable doc, and a guest never owns it — they then see only
 * the docs (and boards) they are invited to.
 */
export const inviteToDoc = async (
  deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>,
  a: Actor,
  docId: string,
  input: z.infer<typeof inviteToDocSchema>,
) => {
  const { db } = deps;
  const access = await loadDocAccess(db, a.ctx, a.user, docId);
  assertDoc(access, 'doc.manage');
  if (access.cell) throw new AppError('bad_request', 'cell_doc');
  if (input.role === 'guest' && access.doc.kind !== 'shareable')
    throw new AppError('invalid_value', 'guest_needs_shareable_doc');

  const res = await inviteNewPeople(deps, a.ctx, a.user, {
    emails: input.emails,
    role: input.role,
    message: input.message,
    sendEmail: input.send_email,
    docIds: [docId],
    docLevel: input.level,
  });
  const errors = [...res.errors];
  const added: { email: string; user_id: string; level: DocLevel; guest: boolean }[] = [];
  const already = new Set((await docMemberRows(db, docId)).flatMap((m) => (m.userId ? [m.userId] : [])));
  await db.transaction(async (tx) => {
    for (const p of res.existing) {
      if (already.has(p.userId)) {
        errors.push({ email: p.email, code: 'already_member' });
        continue;
      }
      if (p.role === 'guest' && access.doc.kind !== 'shareable') {
        errors.push({ email: p.email, code: 'guest_needs_shareable_doc' });
        continue;
      }
      const level: DocLevel = p.role === 'guest' && input.level === 'owner' ? 'editor' : input.level;
      await insertDocMembers(tx, [
        { id: newId(), docId, accountId: a.ctx.accountId, userId: p.userId, level, addedBy: a.user.id },
      ]);
      added.push({ email: p.email, user_id: p.userId, level, guest: p.role === 'guest' });
    }
    if (added.length)
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'doc.members_changed',
        actorId: a.user.id,
        requestId: a.requestId,
        after: { id: docId, added: added.map((x) => ({ user_id: x.user_id, level: input.level })) },
        meta: { doc_id: docId, access_changed: true },
      });
    if (!added.length) return;
    // Shared with them: a notification, and an audit row for each guest.
    const object = { type: 'doc' as const, id: docId, name: access.doc.name };
    await auditGuestShare(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      object,
      added: added.filter((x) => x.guest).map((x) => ({ userId: x.user_id, level: x.level })),
      via: 'invite',
    });
    await notifyShared(
      tx,
      a.ctx.account,
      object,
      a.user.id,
      added.map((x) => x.user_id),
      canOpenDoc(docId),
    );
  });
  return {
    invited: res.invited.map((i) => ({ email: i.email, ...(i.url ? { url: i.url } : {}) })),
    added: added.map(({ email, user_id }) => ({ email, user_id })),
    errors,
  };
};
