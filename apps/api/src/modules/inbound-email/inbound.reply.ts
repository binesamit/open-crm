// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { AppError, DEFAULT_AUTOMATION_EMAILS_PER_DAY, updateEmailMetaOf } from '@bines/shared';
import { emailReply } from '@bines/server-mail';
import { inboundEmails, updates } from '../../db/schema';
import type { AppDeps, Actor } from '../../types';
import { loadItem } from '../items/items.service';
import { accountMailBrand } from '../platform/mail-brand';
import { loadPlatformSettings } from '../platform/platform-settings';
import { assertCanComment, createEmailReplyUpdate } from '../updates/updates.service';
import { findAddressById } from './inbound.repo';
import { itemReplyAddress, memberActor } from './inbound.service';

/**
 * Reply by email: an answer, from the item, to whoever emailed it — the AI tool `reply_by_email`
 * (an agent's draft a person approved, or an autonomous agent's) and any caller of the service. Only to the address
 * the message came from (never another), threaded under it, with the item's own address as Reply-To so the answer
 * comes back to the same item. Kept as the item's update (author = who sent it, `meta.email_reply`); counted in the
 * account's daily email budget like an automation's emails.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'mailer'>;

const reSubject = (subject: string | null | undefined, fallback: string) => {
  const s = (subject ?? '').trim();
  if (!s) return fallback;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
};

/** The replies sent by email from the account's items since `since`. */
const repliesSince = async (deps: Deps, accountId: string, since: Date) =>
  Number(
    (
      await deps.db
        .select({ n: count() })
        .from(updates)
        .where(
          and(eq(updates.accountId, accountId), gte(updates.createdAt, since), sql`${updates.meta} ? 'email_reply'`),
        )
    )[0]?.n ?? 0,
  );

export const replyByEmail = async (
  deps: Deps,
  a: Actor,
  itemId: string,
  input: { text: string; update_id?: string },
) => {
  const { db } = deps;
  const { item } = await loadItem(db, a, itemId);
  await assertCanComment(db, a);
  // The message answered: the one named, else the latest that came to this item.
  const [mail] = await db
    .select()
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.accountId, a.ctx.accountId),
        eq(inboundEmails.itemId, item.id),
        eq(inboundEmails.status, 'done'),
        isNotNull(inboundEmails.updateId),
        input.update_id ? eq(inboundEmails.updateId, input.update_id) : undefined,
      ),
    )
    .orderBy(desc(inboundEmails.createdAt))
    .limit(1);
  if (!mail?.fromEmail) throw new AppError('invalid_value', 'reply_no_email');

  const cap = (await loadPlatformSettings(db)).email.automation_emails_per_day ?? DEFAULT_AUTOMATION_EMAILS_PER_DAY;
  if ((await repliesSince(deps, a.ctx.accountId, new Date(Date.now() - 24 * 3_600_000))) >= cap)
    throw new AppError('conflict', 'email_reply_daily_cap');

  // The answer is written with the rights of whoever opened the address the message came to (else the sender here).
  const origin = await findAddressById(db, mail.addressId);
  const writer =
    (origin ? await memberActor(db, a.ctx.accountId, origin.createdBy, a.requestId ?? 'reply') : null) ?? a;
  const replyTo = await itemReplyAddress(db, writer, item.id);
  if (!replyTo) throw new AppError('forbidden', 'inbound_email_off_account');

  const [original] = await db.select({ meta: updates.meta }).from(updates).where(eq(updates.id, mail.updateId!));
  const subject = reSubject(updateEmailMetaOf(original?.meta)?.subject, item.name).slice(0, 300);
  const text = input.text.trim();
  const brand = await accountMailBrand(deps, a.ctx.account);
  await deps.mailer.send(emailReply({ to: mail.fromEmail, brand, subject, text, replyTo, inReplyTo: mail.messageId }));
  const update = await createEmailReplyUpdate(db, a, item.id, text, { to: mail.fromEmail, subject });
  return { update_id: update.id, item_id: item.id, to: mail.fromEmail, subject };
};
