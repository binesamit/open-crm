// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { InboundKind } from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, inboundAddresses, inboundEmails, users, type InboundAddressRow } from '../../db/schema';

/** The live address of an item or a board, if it has one. */
export const findLiveAddress = async (db: Db, accountId: string, kind: InboundKind, targetId: string) =>
  (
    await db
      .select()
      .from(inboundAddresses)
      .where(
        and(
          eq(inboundAddresses.accountId, accountId),
          eq(inboundAddresses.kind, kind),
          eq(kind === 'item' ? inboundAddresses.itemId : inboundAddresses.boardId, targetId),
          isNull(inboundAddresses.disabledAt),
        ),
      )
      .limit(1)
  )[0];

/** The live address with this token (a retired one is not found). */
export const findAddressByToken = async (db: Db, kind: InboundKind, token: string) =>
  (
    await db
      .select()
      .from(inboundAddresses)
      .where(
        and(eq(inboundAddresses.token, token), eq(inboundAddresses.kind, kind), isNull(inboundAddresses.disabledAt)),
      )
      .limit(1)
  )[0];

export const findAddressById = async (db: Db, id: string) =>
  (await db.select().from(inboundAddresses).where(eq(inboundAddresses.id, id)).limit(1))[0];

/** A new live address; null when another one went live at the same moment (the unique index). */
export const insertAddress = async (db: Db, row: typeof inboundAddresses.$inferInsert) =>
  (await db.insert(inboundAddresses).values(row).onConflictDoNothing().returning())[0] ?? null;

export const disableAddress = (db: Db, id: string) =>
  db.update(inboundAddresses).set({ disabledAt: new Date() }).where(eq(inboundAddresses.id, id));

/** One message for one address, once: null when it was logged already (the provider retried the webhook). */
export const logInboundEmail = async (db: Db, row: typeof inboundEmails.$inferInsert) =>
  (await db.insert(inboundEmails).values(row).onConflictDoNothing().returning())[0] ?? null;

export const findInboundEmail = async (db: Db, id: string) =>
  (await db.select().from(inboundEmails).where(eq(inboundEmails.id, id)).limit(1))[0];

/** Sets the Message-ID; false when this address took a message with that id already (the same mail again). */
export const setMessageId = async (db: Db, id: string, messageId: string) => {
  const res = await db.execute(
    sql`update inbound_emails set message_id = ${messageId} where id = ${id}
        and not exists (select 1 from inbound_emails o where o.address_id = inbound_emails.address_id
                        and o.message_id = ${messageId} and o.id <> ${id})`,
  );
  return (res as unknown as { rowCount?: number }).rowCount === 1;
};

export const finishInboundEmail = (
  db: Db,
  id: string,
  out: {
    status: 'done' | 'rejected' | 'failed';
    reason?: string | null;
    fromEmail?: string;
    itemId?: string | null;
    updateId?: string | null;
  },
) =>
  db
    .update(inboundEmails)
    .set({
      status: out.status,
      reason: out.reason ?? null,
      ...(out.fromEmail !== undefined ? { fromEmail: out.fromEmail.slice(0, 320) } : {}),
      itemId: out.itemId ?? null,
      updateId: out.updateId ?? null,
      finishedAt: new Date(),
    })
    .where(eq(inboundEmails.id, id));

/** Messages taken in the last hour by an address or an account (other than `exceptId`) — the hourly limits. */
export const recentCount = async (
  db: Db,
  by: { addressId: string } | { accountId: string },
  since: Date,
  exceptId: string,
) => {
  const scope =
    'addressId' in by ? eq(inboundEmails.addressId, by.addressId) : eq(inboundEmails.accountId, by.accountId);
  const [row] = await db
    .select({ n: count() })
    .from(inboundEmails)
    .where(and(scope, gte(inboundEmails.createdAt, since), ne(inboundEmails.id, exceptId)));
  return Number(row?.n ?? 0);
};

/**
 * The account's active member with this address and a verified email, if any — the only case where incoming mail
 * is written in a member's name (anyone can put any address in a From line; a verified one is the account's word
 * that the address is theirs, and the provider's SPF / DKIM check is the message's).
 */
export const findVerifiedMemberByEmail = async (db: Db, accountId: string, email: string) =>
  (
    await db
      .select({ userId: users.id })
      .from(users)
      .innerJoin(accountMembers, eq(accountMembers.userId, users.id))
      .where(
        and(
          sql`lower(${users.email}) = ${email.toLowerCase()}`,
          eq(users.emailVerified, true),
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.status, 'active'),
        ),
      )
      .limit(1)
  )[0]?.userId ?? null;

export type { InboundAddressRow };
