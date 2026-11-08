// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { smsSegments } from '@bines/shared';
import type { Mailer } from '@bines/server-mail';
import type { Db } from '../../db/client';
import { usageMeter } from '../../db/schema';
import type { SmsSender } from '../../lib/sms';

/**
 * Usage the platform counts as it happens: one row per day × account × metric, added to on every
 * email, SMS part, web search and automation run. Read by the `internal` cost source. A count that fails is dropped — it never
 * fails the send it counts.
 */
export const METER = {
  email: 'email_sent',
  smsSegments: 'sms_segments',
  webSearch: 'web_search_calls',
  automationRuns: 'automation_runs',
  storage: 'storage',
} as const;

export const meterDay = (at = new Date()) => at.toISOString().slice(0, 10);

export const bumpMeter = async (
  db: Db,
  metric: string,
  quantity: number,
  accountId?: string | null,
  at = new Date(),
): Promise<void> => {
  if (!(quantity > 0)) return;
  try {
    await db
      .insert(usageMeter)
      .values({ day: meterDay(at), accountRef: accountId ?? '', metric, quantity })
      .onConflictDoUpdate({
        target: [usageMeter.day, usageMeter.accountRef, usageMeter.metric],
        set: { quantity: sql`${usageMeter.quantity} + excluded.quantity` },
      });
  } catch {
    // A lost count costs a cent of accuracy; a failed send would cost the message.
  }
};

/** A day's level (not a count): the day's stored bytes. Replaces what the day had. */
export const setMeter = (db: Db, day: string, metric: string, rows: { accountRef: string; quantity: number }[]) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`delete from usage_meter where day = ${day} and metric = ${metric}`);
    if (rows.length) await tx.insert(usageMeter).values(rows.map((r) => ({ day, metric, ...r })));
  });

/** Counts every email sent (one recipient per message), after the send succeeded. */
export const meteringMailer = (db: Db, inner: Mailer): Mailer =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'send') return Reflect.get(target, prop, receiver);
      return async (message: Parameters<Mailer['send']>[0]) => {
        await target.send(message);
        void bumpMeter(db, METER.email, 1);
      };
    },
  });

/** Counts the SMS parts of every text sent (a long or Hebrew text takes several), on the sending account. */
export const meteringSms = (db: Db, inner: SmsSender): SmsSender =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'send') return Reflect.get(target, prop, receiver);
      return async (message: Parameters<SmsSender['send']>[0]) => {
        const out = await target.send(message);
        void bumpMeter(db, METER.smsSegments, smsSegments(message.text), message.accountId);
        return out;
      };
    },
  });
