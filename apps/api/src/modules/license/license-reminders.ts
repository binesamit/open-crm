// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { t } from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { AppDeps } from '../../types';
import { platformMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { licenseSigner } from './license-signing';
import {
  claimReminder,
  type IssuedLicenseRow,
  licensesExpiringBetween,
  platformOwnerContacts,
  releaseReminder,
} from './license.repo';
import { asPlan } from './license-server.service';
import { loadLicenseOps, paymentsReady, pricedPlans, reminderSettings } from './license-ops.settings';

/**
 * Expiry reminders — on the license server only. An hourly job finds the licenses (not revoked)
 * whose expiry is within the largest "days before" setting, and for each sends the reminder of the nearest
 * threshold it has reached (30 days, then 7 — by default) to the customer (the license's email) and to the platform
 * owners. Each (license, expiry, days) is claimed once in `license_reminders`, so a re-run, a second process or a
 * restart never sends twice; a renewal moves the expiry, so the reminders start over. A failed email frees its claim
 * and the next hour tries again.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'mailer' | 'secrets'>;

const DAY_MS = 86_400_000;

export type ReminderRunResult =
  { status: 'not_server' | 'disabled' } | { status: 'ran'; sent: { license_id: string; days: number }[] };

const dateText = (d: Date, locale: string) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'he-IL', { dateStyle: 'long', timeZone: 'UTC' }).format(d);

/** The threshold a license has reached now: the smallest setting not below the days left (null = none yet). */
export const dueThreshold = (expires: Date, now: Date, days: number[]) => {
  const left = (expires.getTime() - now.getTime()) / DAY_MS;
  if (left <= 0) return null;
  const reached = days.filter((d) => left <= d);
  return reached.length ? Math.min(...reached) : null;
};

const sendCustomer = async (deps: Deps, row: IssuedLicenseRow, days: number, renewUrl: string | null) => {
  const brand = await platformMailBrand(deps, undefined);
  const l = brand.locale;
  const vars = {
    product: brand.product,
    licensee: row.licensee,
    plan: t(`licensing.plan.${asPlan(row.plan)}`, undefined, l),
    date: dateText(row.expires!, l),
    days,
  };
  await deps.mailer.send(
    noticeEmail({
      to: row.email!,
      brand,
      subject: t('licensing.mail.reminder.subject', vars, l),
      title: t('licensing.mail.reminder.title', vars, l),
      hero: {
        kind: 'calendar',
        n: days,
        head: t('mail.obj.cal.license', undefined, l),
        unit: t('mail.obj.cal.unit', undefined, l),
      },
      lines: [
        t('licensing.mail.reminder.intro', vars, l),
        t(row.paymentSubscriptionId ? 'licensing.mail.reminder.auto' : 'licensing.mail.reminder.howto', vars, l),
      ],
      ...(renewUrl && !row.paymentSubscriptionId
        ? { cta: { label: t('licensing.mail.reminder.cta', undefined, l), url: renewUrl } }
        : {}),
      reason: t('licensing.mail.reason', { email: row.email!, product: brand.product }, l),
    }),
  );
};

const sendOwner = async (deps: Deps, to: { email: string; locale: string }, row: IssuedLicenseRow, days: number) => {
  const brand = await platformMailBrand(deps, to.locale);
  const l = brand.locale;
  const vars = {
    product: brand.product,
    licensee: row.licensee,
    plan: t(`licensing.plan.${asPlan(row.plan)}`, undefined, l),
    date: dateText(row.expires!, l),
    days,
    email: row.email ?? '—',
    ref: row.ref,
  };
  await deps.mailer.send(
    noticeEmail({
      to: to.email,
      brand,
      subject: t('licensing.mail.reminderOwner.subject', vars, l),
      title: t('licensing.mail.reminderOwner.title', vars, l),
      lines: [t('licensing.mail.reminderOwner.intro', vars, l), t('licensing.mail.reminderOwner.howto', vars, l)],
      reason: t('licensing.mail.reminderOwner.reason', { product: brand.product }, l),
    }),
  );
};

/** One pass of the job (also called by tests with a chosen `now`). */
export const sendExpiryReminders = async (deps: Deps, now = new Date()): Promise<ReminderRunResult> => {
  if (!(await licenseSigner(deps))) return { status: 'not_server' };
  const ops = await loadLicenseOps(deps);
  const settings = reminderSettings(ops);
  if (!settings.enabled) return { status: 'disabled' };
  const horizon = new Date(now.getTime() + Math.max(...settings.days) * DAY_MS);
  const due = (await licensesExpiringBetween(deps.db, now, horizon))
    .map((row) => ({ row, days: dueThreshold(row.expires!, now, settings.days) }))
    .filter((x): x is { row: IssuedLicenseRow; days: number } => x.days !== null);
  if (!due.length) return { status: 'ran', sent: [] };
  const owners = await platformOwnerContacts(deps.db);
  const priced = paymentsReady(ops) ? pricedPlans(ops).map((p) => p.plan as string) : [];
  const sent: { license_id: string; days: number }[] = [];
  for (const { row, days } of due) {
    if (!(await claimReminder(deps.db, row.id, row.expires!, days))) continue;
    try {
      const renewUrl = priced.includes(row.plan)
        ? await appLink(
            deps,
            `/buy?plan=${row.plan}${row.instanceId ? `&instance=${encodeURIComponent(row.instanceId)}` : ''}`,
          )
        : null;
      if (row.email) await sendCustomer(deps, row, days, renewUrl);
      for (const o of owners)
        if (o.email.toLowerCase() !== row.email?.toLowerCase()) await sendOwner(deps, o, row, days);
      sent.push({ license_id: row.id, days });
    } catch (err) {
      await releaseReminder(deps.db, row.id, row.expires!, days);
      deps.logger.warn(
        { err: err instanceof Error ? err.message : 'error', license: row.ref, days },
        'license expiry reminder failed',
      );
    }
  }
  if (sent.length) deps.logger.info({ sent: sent.length }, 'license expiry reminders sent');
  return { status: 'ran', sent };
};

export const LICENSE_REMINDERS_TASK = 'license.expiry_reminders';

export const licenseTasks = (deps: AppDeps): TaskList => ({
  [LICENSE_REMINDERS_TASK]: async () => {
    await sendExpiryReminders(deps);
  },
});

/** Hourly (every installation schedules it; it does nothing where this is not a license server). */
export const licenseCronItems: CronItem[] = [
  { task: LICENSE_REMINDERS_TASK, match: '17 * * * *', identifier: LICENSE_REMINDERS_TASK },
];
