// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './trash.repo';

/**
 * SLA breach alerts of support tickets (stage 5): tickets still being worked whose first-response or
 * resolution deadline passed and was not announced yet. The rules match `firstBreachSql` / `resolutionBreachSql`
 * (apps/api/src/modules/tickets/tickets.repo.ts) for tickets not answered / not solved yet.
 */
export type BreachRow = {
  id: string;
  number: number;
  subject: string;
  assignee_id: string | null;
  account_name: string;
  first: boolean;
  resolution: boolean;
};

export const dueBreaches = async (db: SqlClient, now: Date, limit = 200) =>
  (
    await db.query(
      `select * from (
         select t.id, t.number, t.subject, t.assignee_id, a.name as account_name,
           (t.first_breach_alerted_at is null and t.first_responded_at is null
             and t.first_response_due_at is not null and t.first_response_due_at < $1) as first,
           (t.resolution_breach_alerted_at is null and t.solved_at is null and t.sla_paused_at is null
             and t.resolution_due_at is not null and t.resolution_due_at < $1) as resolution
         from support_tickets t
         join accounts a on a.id = t.account_id
         where t.deleted_at is null and t.status in ('new', 'open', 'pending_customer', 'on_hold')
       ) x
       where x.first or x.resolution
       order by x.number
       limit $2`,
      [now, limit],
    )
  ).rows as BreachRow[];

export type StaffRecipient = { id: string; email: string; locale: string | null };

/** Who hears about a breach: the assignee, else every active lead and platform owner. */
export const breachRecipients = async (db: SqlClient, assigneeId: string | null) => {
  if (assigneeId)
    return (await db.query(`select id, email, locale from users where id = $1`, [assigneeId])).rows as StaffRecipient[];
  return (
    await db.query(
      `select distinct u.id, u.email, u.locale from users u
       left join support_staff s on lower(s.email) = lower(u.email) and s.status = 'active' and s.role = 'lead'
       where u.is_platform_owner or (s.id is not null and u.email_verified)`,
    )
  ).rows as StaffRecipient[];
};

export const markBreachAlerted = (
  db: SqlClient,
  id: string,
  kinds: { first: boolean; resolution: boolean },
  now: Date,
) =>
  db.query(
    `update support_tickets set
       first_breach_alerted_at = case when $2 then $4::timestamptz else first_breach_alerted_at end,
       resolution_breach_alerted_at = case when $3 then $4::timestamptz else resolution_breach_alerted_at end
     where id = $1`,
    [id, kinds.first, kinds.resolution, now],
  );

/** The helpdesk settings row (owner console → Support → Settings), raw. */
export const helpdeskSettingsRow = async (db: SqlClient) =>
  (
    (await db.query(`select settings from platform_settings where id = 'helpdesk'`)).rows[0] as
      { settings: unknown } | undefined
  )?.settings ?? {};
