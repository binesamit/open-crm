// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  assets,
  supportAccessGrants,
  supportAccessRequests,
  supportCannedReplies,
  supportCategories,
  supportQueues,
  supportSlaPolicies,
  supportStaff,
  supportTags,
  supportTicketAssignments,
  supportTicketAttachments,
  supportTicketEvents,
  supportTicketMessages,
  supportTickets,
  supportTicketTags,
  users,
} from '../../db/schema';

/** Support tickets: every query of the helpdesk's tables. */
export type TicketRow = typeof supportTickets.$inferSelect;
export type MessageRow = typeof supportTicketMessages.$inferSelect;
export type QueueRow = typeof supportQueues.$inferSelect;
export type CategoryRow = typeof supportCategories.$inferSelect;
export type SlaRow = typeof supportSlaPolicies.$inferSelect;
export type CannedRow = typeof supportCannedReplies.$inferSelect;
export type TagRow = typeof supportTags.$inferSelect;
export type StaffRow = typeof supportStaff.$inferSelect;
export type AccessRequestRow = typeof supportAccessRequests.$inferSelect;

// ---- staff ----

/** The active support role of a person: their verified address is an active staff row. */
export const findStaffRoleOf = async (db: Db, userId: string) =>
  (
    await db
      .select({ role: supportStaff.role, id: supportStaff.id })
      .from(supportStaff)
      .innerJoin(users, eq(sql`lower(${users.email})`, sql`lower(${supportStaff.email})`))
      .where(and(eq(users.id, userId), eq(users.emailVerified, true), eq(supportStaff.status, 'active')))
      .limit(1)
  )[0];

export const listStaff = (db: Db) =>
  db
    .select({ staff: supportStaff, name: users.name, linkedId: users.id })
    .from(supportStaff)
    .leftJoin(users, eq(sql`lower(${users.email})`, sql`lower(${supportStaff.email})`))
    .orderBy(asc(supportStaff.createdAt));

export const findStaffById = async (db: Db, id: string) =>
  (await db.select().from(supportStaff).where(eq(supportStaff.id, id)).limit(1))[0];

export const findStaffByEmail = async (db: Db, email: string) =>
  (
    await db
      .select()
      .from(supportStaff)
      .where(eq(sql`lower(${supportStaff.email})`, email.toLowerCase()))
      .limit(1)
  )[0];

export const insertStaff = async (db: Db, row: Omit<typeof supportStaff.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportStaff).values({ ...row, id });
  return (await findStaffById(db, id))!;
};

export const updateStaffRow = (db: Db, id: string, patch: Partial<typeof supportStaff.$inferInsert>) =>
  db
    .update(supportStaff)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(supportStaff.id, id));

/** Everyone who works tickets: active staff with an account, and the platform owners. */
export const listAgents = async (db: Db) => {
  const staff = await db
    .select({ id: users.id, name: users.name, email: users.email, role: supportStaff.role })
    .from(supportStaff)
    .innerJoin(users, eq(sql`lower(${users.email})`, sql`lower(${supportStaff.email})`))
    .where(and(eq(supportStaff.status, 'active'), eq(users.emailVerified, true)));
  const owners = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.isPlatformOwner, true));
  const out = new Map<string, { id: string; name: string; email: string; role: 'owner' | 'agent' | 'lead' }>();
  for (const o of owners) out.set(o.id, { ...o, name: o.name || o.email, role: 'owner' });
  for (const s of staff)
    if (!out.has(s.id)) out.set(s.id, { ...s, name: s.name || s.email, role: s.role === 'lead' ? 'lead' : 'agent' });
  return [...out.values()];
};

export const findUser = async (db: Db, id: string) =>
  (
    await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        locale: users.locale,
        emailVerified: users.emailVerified,
        isPlatformOwner: users.isPlatformOwner,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
  )[0];

// ---- configuration ----

export const listQueues = (db: Db) =>
  db.select().from(supportQueues).orderBy(asc(supportQueues.position), asc(supportQueues.createdAt));
export const findQueue = async (db: Db, id: string) =>
  (await db.select().from(supportQueues).where(eq(supportQueues.id, id)).limit(1))[0];
export const defaultQueue = async (db: Db) =>
  (
    await db
      .select()
      .from(supportQueues)
      .where(and(eq(supportQueues.isDefault, true), isNull(supportQueues.archivedAt)))
      .limit(1)
  )[0];
export const insertQueue = async (db: Db, row: Omit<typeof supportQueues.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportQueues).values({ ...row, id });
  return (await findQueue(db, id))!;
};
export const updateQueueRow = (db: Db, id: string, patch: Partial<typeof supportQueues.$inferInsert>) =>
  db.update(supportQueues).set(patch).where(eq(supportQueues.id, id));
export const clearDefaultQueue = (db: Db) =>
  db.update(supportQueues).set({ isDefault: false }).where(eq(supportQueues.isDefault, true));

export const listCategories = (db: Db) =>
  db.select().from(supportCategories).orderBy(asc(supportCategories.position), asc(supportCategories.createdAt));
export const findCategory = async (db: Db, id: string) =>
  (await db.select().from(supportCategories).where(eq(supportCategories.id, id)).limit(1))[0];
export const insertCategory = async (db: Db, row: Omit<typeof supportCategories.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportCategories).values({ ...row, id });
  return (await findCategory(db, id))!;
};
export const updateCategoryRow = (db: Db, id: string, patch: Partial<typeof supportCategories.$inferInsert>) =>
  db.update(supportCategories).set(patch).where(eq(supportCategories.id, id));

export const listSla = (db: Db) => db.select().from(supportSlaPolicies);
export const findSla = async (db: Db, priority: string) =>
  (await db.select().from(supportSlaPolicies).where(eq(supportSlaPolicies.priority, priority)).limit(1))[0];
export const upsertSla = (db: Db, row: typeof supportSlaPolicies.$inferInsert) =>
  db
    .insert(supportSlaPolicies)
    .values(row)
    .onConflictDoUpdate({
      target: supportSlaPolicies.priority,
      set: {
        firstResponseMinutes: row.firstResponseMinutes,
        resolutionMinutes: row.resolutionMinutes,
        businessHours: row.businessHours,
        updatedAt: new Date(),
      },
    });

export const listCanned = (db: Db) => db.select().from(supportCannedReplies).orderBy(asc(supportCannedReplies.title));
export const findCanned = async (db: Db, id: string) =>
  (await db.select().from(supportCannedReplies).where(eq(supportCannedReplies.id, id)).limit(1))[0];
export const insertCanned = async (db: Db, row: Omit<typeof supportCannedReplies.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportCannedReplies).values({ ...row, id });
  return (await findCanned(db, id))!;
};
export const updateCannedRow = (db: Db, id: string, patch: Partial<typeof supportCannedReplies.$inferInsert>) =>
  db
    .update(supportCannedReplies)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(supportCannedReplies.id, id));

export const listTags = (db: Db) => db.select().from(supportTags).orderBy(asc(supportTags.name));
export const findTag = async (db: Db, id: string) =>
  (await db.select().from(supportTags).where(eq(supportTags.id, id)).limit(1))[0];
export const findTagByName = async (db: Db, name: string) =>
  (
    await db
      .select()
      .from(supportTags)
      .where(eq(sql`lower(${supportTags.name})`, name.toLowerCase()))
      .limit(1)
  )[0];
export const insertTag = async (db: Db, row: Omit<typeof supportTags.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportTags).values({ ...row, id });
  return (await findTag(db, id))!;
};
export const updateTagRow = (db: Db, id: string, patch: Partial<typeof supportTags.$inferInsert>) =>
  db.update(supportTags).set(patch).where(eq(supportTags.id, id));
export const deleteTagRow = (db: Db, id: string) => db.delete(supportTags).where(eq(supportTags.id, id));

// ---- tickets ----

/** The next ticket number: the sequence, never below the configured start. */
export const nextTicketNumber = async (db: Db, start: number) => {
  const res = (await db.execute(sql`select nextval('support_ticket_number_seq')::int as n`)) as unknown as {
    rows: { n: number }[];
  };
  const n = Number(res.rows[0]!.n);
  if (n >= start) return n;
  const set = (await db.execute(sql`select setval('support_ticket_number_seq', ${start})::int as n`)) as unknown as {
    rows: { n: number }[];
  };
  return Number(set.rows[0]!.n);
};

export const insertTicket = async (db: Db, row: typeof supportTickets.$inferInsert) => {
  await db.insert(supportTickets).values(row);
  return (await findTicket(db, row.id!))!;
};

export const findTicket = async (db: Db, id: string) =>
  (
    await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, id), isNull(supportTickets.deletedAt)))
      .limit(1)
  )[0];

export const updateTicketRow = (db: Db, id: string, patch: Partial<typeof supportTickets.$inferInsert>) =>
  db
    .update(supportTickets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(supportTickets.id, id));

/** Breach conditions (SQL) — the same rules as `slaOf` in sla.ts. */
export const firstBreachSql = sql`(${supportTickets.firstResponseDueAt} is not null and (
  (${supportTickets.firstRespondedAt} is null and now() > ${supportTickets.firstResponseDueAt})
  or ${supportTickets.firstRespondedAt} > ${supportTickets.firstResponseDueAt}))`;
export const resolutionBreachSql = sql`(${supportTickets.resolutionDueAt} is not null and (
  (${supportTickets.solvedAt} is null and ${supportTickets.slaPausedAt} is null and now() > ${supportTickets.resolutionDueAt})
  or (${supportTickets.solvedAt} is null and ${supportTickets.slaPausedAt} > ${supportTickets.resolutionDueAt})
  or ${supportTickets.solvedAt} > ${supportTickets.resolutionDueAt}))`;

export type TicketQuery = {
  accountId?: string;
  requesterId?: string;
  statuses?: string[];
  priorities?: string[];
  categoryId?: string;
  queueId?: string;
  assignee?: { kind: 'none' } | { kind: 'user'; id: string };
  tagId?: string;
  breached?: 'any' | 'first_response' | 'resolution';
  q?: string;
  before?: string;
  limit: number;
};

/** A page of tickets (newest first) with the names the lists show. */
export const queryTickets = (db: Db, f: TicketQuery) => {
  const where: (SQL | undefined)[] = [isNull(supportTickets.deletedAt)];
  if (f.accountId) where.push(eq(supportTickets.accountId, f.accountId));
  if (f.requesterId) where.push(eq(supportTickets.requesterId, f.requesterId));
  if (f.statuses?.length) where.push(inArray(supportTickets.status, f.statuses));
  if (f.priorities?.length) where.push(inArray(supportTickets.priority, f.priorities));
  if (f.categoryId) where.push(eq(supportTickets.categoryId, f.categoryId));
  if (f.queueId) where.push(eq(supportTickets.queueId, f.queueId));
  if (f.assignee?.kind === 'none') where.push(isNull(supportTickets.assigneeId));
  if (f.assignee?.kind === 'user') where.push(eq(supportTickets.assigneeId, f.assignee.id));
  if (f.tagId)
    where.push(
      sql`exists (select 1 from ${supportTicketTags} tt where tt.ticket_id = ${supportTickets.id} and tt.tag_id = ${f.tagId})`,
    );
  if (f.breached === 'first_response') where.push(firstBreachSql);
  if (f.breached === 'resolution') where.push(resolutionBreachSql);
  if (f.breached === 'any') where.push(or(firstBreachSql, resolutionBreachSql));
  if (f.q?.trim()) {
    const q = f.q.trim();
    const n = /^#?\d{1,9}$/.test(q) ? Number(q.replace('#', '')) : null;
    where.push(
      or(
        ilike(supportTickets.subject, `%${q.replace(/[%_\\]/g, '\\$&')}%`),
        n !== null ? eq(supportTickets.number, n) : undefined,
      ),
    );
  }
  if (f.before) where.push(lt(supportTickets.id, f.before));
  return ticketSelect(db)
    .where(and(...where))
    .orderBy(desc(supportTickets.id))
    .limit(f.limit + 1);
};
export type TicketListRow = Awaited<ReturnType<typeof queryTickets>>[number];

/** One ticket with the names the views show. */
export const findTicketListRow = async (db: Db, id: string) =>
  (
    await ticketSelect(db)
      .where(and(eq(supportTickets.id, id), isNull(supportTickets.deletedAt)))
      .limit(1)
  )[0];

const ticketSelect = (db: Db) =>
  db
    .select({
      t: supportTickets,
      categoryName: supportCategories.name,
      queueName: supportQueues.name,
      assigneeName: users.name,
      accountName: accounts.name,
      accountSlug: accounts.slug,
    })
    .from(supportTickets)
    .innerJoin(accounts, eq(accounts.id, supportTickets.accountId))
    .leftJoin(supportCategories, eq(supportCategories.id, supportTickets.categoryId))
    .leftJoin(supportQueues, eq(supportQueues.id, supportTickets.queueId))
    .leftJoin(users, eq(users.id, supportTickets.assigneeId));

export const ticketTagsOf = async (db: Db, ticketIds: string[]) =>
  ticketIds.length
    ? db
        .select({
          ticketId: supportTicketTags.ticketId,
          id: supportTags.id,
          name: supportTags.name,
          color: supportTags.color,
        })
        .from(supportTicketTags)
        .innerJoin(supportTags, eq(supportTags.id, supportTicketTags.tagId))
        .where(inArray(supportTicketTags.ticketId, ticketIds))
    : [];

export const setTicketTags = async (db: Db, ticketId: string, tagIds: string[]) => {
  await db.delete(supportTicketTags).where(eq(supportTicketTags.ticketId, ticketId));
  if (tagIds.length) await db.insert(supportTicketTags).values(tagIds.map((tagId) => ({ ticketId, tagId })));
};

// ---- messages, attachments, events ----

export const insertMessage = async (db: Db, row: Omit<typeof supportTicketMessages.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportTicketMessages).values({ ...row, id });
  return id;
};

/** A ticket's thread, oldest first; `publicOnly` = what the customer may see (never internal notes). */
export const listMessages = (db: Db, ticketId: string, publicOnly: boolean) =>
  db
    .select()
    .from(supportTicketMessages)
    .where(
      and(
        eq(supportTicketMessages.ticketId, ticketId),
        publicOnly ? eq(supportTicketMessages.visibility, 'public') : undefined,
      ),
    )
    .orderBy(asc(supportTicketMessages.createdAt), asc(supportTicketMessages.id));

export const insertAttachments = async (db: Db, ticketId: string, messageId: string, assetIds: string[]) => {
  if (assetIds.length)
    await db
      .insert(supportTicketAttachments)
      .values(assetIds.map((assetId) => ({ id: newId(), ticketId, messageId, assetId })));
};

export const listAttachments = (db: Db, ticketId: string) =>
  db
    .select({ a: supportTicketAttachments, asset: assets })
    .from(supportTicketAttachments)
    .innerJoin(assets, eq(assets.id, supportTicketAttachments.assetId))
    .where(eq(supportTicketAttachments.ticketId, ticketId));

export const findAttachment = async (db: Db, ticketId: string, attachmentId: string) =>
  (
    await db
      .select({ a: supportTicketAttachments, asset: assets, visibility: supportTicketMessages.visibility })
      .from(supportTicketAttachments)
      .innerJoin(assets, eq(assets.id, supportTicketAttachments.assetId))
      .leftJoin(supportTicketMessages, eq(supportTicketMessages.id, supportTicketAttachments.messageId))
      .where(and(eq(supportTicketAttachments.ticketId, ticketId), eq(supportTicketAttachments.id, attachmentId)))
      .limit(1)
  )[0];

export const insertEvent = (db: Db, ticketId: string, actorId: string | null, type: string, data: object = {}) =>
  db
    .insert(supportTicketEvents)
    .values({ id: newId(), ticketId, actorId, type, data: data as Record<string, unknown> });

export const listEvents = (db: Db, ticketId: string) =>
  db
    .select({ e: supportTicketEvents, actorName: users.name })
    .from(supportTicketEvents)
    .leftJoin(users, eq(users.id, supportTicketEvents.actorId))
    .where(eq(supportTicketEvents.ticketId, ticketId))
    .orderBy(asc(supportTicketEvents.createdAt), asc(supportTicketEvents.id));

export const recordAssignment = async (db: Db, ticketId: string, assigneeId: string | null, by: string) => {
  await db
    .update(supportTicketAssignments)
    .set({ unassignedAt: new Date() })
    .where(and(eq(supportTicketAssignments.ticketId, ticketId), isNull(supportTicketAssignments.unassignedAt)));
  if (assigneeId)
    await db.insert(supportTicketAssignments).values({ id: newId(), ticketId, assigneeId, assignedBy: by });
};

// ---- access requests ----

export const insertAccessRequest = async (db: Db, row: Omit<typeof supportAccessRequests.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportAccessRequests).values({ ...row, id });
  return (await findAccessRequest(db, id))!;
};

export const findAccessRequest = async (db: Db, id: string) =>
  (await db.select().from(supportAccessRequests).where(eq(supportAccessRequests.id, id)).limit(1))[0];

export const listAccessRequests = (db: Db, ticketId: string) =>
  db
    .select({
      r: supportAccessRequests,
      requesterName: sql<
        string | null
      >`(select coalesce(nullif(u.name, ''), u.email) from users u where u.id = ${supportAccessRequests.requestedBy})`,
      deciderName: sql<
        string | null
      >`(select coalesce(nullif(u.name, ''), u.email) from users u where u.id = ${supportAccessRequests.decidedBy})`,
      grant: supportAccessGrants,
    })
    .from(supportAccessRequests)
    .leftJoin(supportAccessGrants, eq(supportAccessGrants.id, supportAccessRequests.grantId))
    .where(eq(supportAccessRequests.ticketId, ticketId))
    .orderBy(desc(supportAccessRequests.createdAt));

/** Decides a pending request once (returns whether it changed). */
export const decideAccessRequest = async (
  db: Db,
  id: string,
  patch: { status: string; decidedBy: string | null; grantId?: string | null },
) =>
  (
    await db
      .update(supportAccessRequests)
      .set({ status: patch.status, decidedBy: patch.decidedBy, decidedAt: new Date(), grantId: patch.grantId ?? null })
      .where(and(eq(supportAccessRequests.id, id), eq(supportAccessRequests.status, 'pending')))
      .returning({ id: supportAccessRequests.id })
  ).length > 0;

/** Every pending request of a ticket ends (the ticket was solved or closed). */
export const cancelPendingRequests = (db: Db, ticketId: string, by: string | null) =>
  db
    .update(supportAccessRequests)
    .set({ status: 'cancelled', decidedBy: by, decidedAt: new Date() })
    .where(and(eq(supportAccessRequests.ticketId, ticketId), eq(supportAccessRequests.status, 'pending')))
    .returning({ id: supportAccessRequests.id });

// ---- people of the account ----

/** Active admins of an account (approvers of access requests). */
/** Is this person an active member of the account (a notification may reach them)? */
export const isActiveMember = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.userId, userId),
          eq(accountMembers.status, 'active'),
        ),
      )
      .limit(1)
  ).length > 0;

// ---- reports ----

type Num = number | string | null;
const num = (v: Num) => (v === null || v === undefined ? null : Number(v));

export const reportCounts = async (db: Db, since: Date) => {
  const [row] = await db
    .select({
      created: sql<Num>`count(*) filter (where ${supportTickets.createdAt} >= ${since})`,
      solved: sql<Num>`count(*) filter (where ${supportTickets.solvedAt} >= ${since})`,
      openNow: sql<Num>`count(*) filter (where ${supportTickets.status} in ('new', 'open', 'pending_customer', 'on_hold'))`,
      breachedNow: sql<Num>`count(*) filter (where ${supportTickets.status} in ('new', 'open', 'pending_customer', 'on_hold') and (${firstBreachSql} or ${resolutionBreachSql}))`,
      csatCount: sql<Num>`count(${supportTickets.csatRating}) filter (where ${supportTickets.csatAt} >= ${since})`,
      csatAvg: sql<Num>`avg(${supportTickets.csatRating}) filter (where ${supportTickets.csatAt} >= ${since})`,
      csatSatisfied: sql<Num>`count(*) filter (where ${supportTickets.csatAt} >= ${since} and ${supportTickets.csatRating} >= 4)`,
    })
    .from(supportTickets)
    .where(isNull(supportTickets.deletedAt));
  return {
    created: num(row!.created) ?? 0,
    solved: num(row!.solved) ?? 0,
    openNow: num(row!.openNow) ?? 0,
    breachedNow: num(row!.breachedNow) ?? 0,
    csatCount: num(row!.csatCount) ?? 0,
    csatAvg: num(row!.csatAvg),
    csatSatisfied: num(row!.csatSatisfied) ?? 0,
  };
};

/** Minutes from creation to first response / to solved, of tickets created since `since`. */
export const reportDurations = (db: Db, since: Date) =>
  db
    .select({
      assigneeId: supportTickets.assigneeId,
      createdAt: supportTickets.createdAt,
      firstRespondedAt: supportTickets.firstRespondedAt,
      solvedAt: supportTickets.solvedAt,
      categoryId: supportTickets.categoryId,
    })
    .from(supportTickets)
    .where(and(isNull(supportTickets.deletedAt), gte(supportTickets.createdAt, since)));

export const reportByCategory = (db: Db, since: Date) =>
  db
    .select({ id: supportTickets.categoryId, name: supportCategories.name, count: count() })
    .from(supportTickets)
    .leftJoin(supportCategories, eq(supportCategories.id, supportTickets.categoryId))
    .where(and(isNull(supportTickets.deletedAt), gte(supportTickets.createdAt, since)))
    .groupBy(supportTickets.categoryId, supportCategories.name);

export const reportSolvedSince = (db: Db, since: Date) =>
  db
    .select({ solvedAt: supportTickets.solvedAt, assigneeId: supportTickets.assigneeId })
    .from(supportTickets)
    .where(and(isNull(supportTickets.deletedAt), gte(supportTickets.solvedAt, since)));
