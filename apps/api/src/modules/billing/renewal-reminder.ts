// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { noticeEmail } from '@bines/server-mail';
import { accountSubscriptions, planVersions, plans, users } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AppDeps } from '../../types';
import { findAccountById } from '../accounts/accounts.repo';
import { accountMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { loadBillingSettings } from './billing-settings';
import { activeAdminIds, updateSubscription } from './plans.repo';

/**
 * The yearly renewal reminder: `renewal_reminder_days` before a yearly subscription renews by itself
 * its admins are emailed the date and how to cancel or change it — once per renewal (`renewal_reminded_for` = the
 * period end reminded). Off when the setting is empty. A subscription already cancelled is not reminded.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'mailer'>;

export const sendRenewalReminders = async (deps: Deps, now = new Date()) => {
  const days = (await loadBillingSettings(deps.db)).renewal_reminder_days;
  if (days === null) return 0;
  const until = new Date(now.getTime() + days * 86_400_000);
  const due = await deps.db
    .select({ s: accountSubscriptions, plan: plans.name })
    .from(accountSubscriptions)
    .innerJoin(planVersions, eq(planVersions.id, accountSubscriptions.planVersionId))
    .innerJoin(plans, eq(plans.id, planVersions.planId))
    .where(
      and(
        isNull(accountSubscriptions.endedAt),
        eq(accountSubscriptions.interval, 'year'),
        eq(accountSubscriptions.status, 'active'),
        eq(accountSubscriptions.cancelAtPeriodEnd, false),
        gt(accountSubscriptions.periodEnd, now),
        lte(accountSubscriptions.periodEnd, until),
      ),
    )
    .limit(500);
  let sent = 0;
  for (const { s, plan } of due) {
    if (!s.periodEnd || (s.renewalRemindedFor && s.renewalRemindedFor.getTime() === s.periodEnd.getTime())) continue;
    const account = await findAccountById(deps.db, s.accountId);
    const ids = account ? await activeAdminIds(deps.db, s.accountId) : [];
    // Marked first: a mail failure never turns into a reminder every hour.
    await updateSubscription(deps.db, s.id, { renewalRemindedFor: s.periodEnd });
    if (!account || !ids.length) continue;
    const admins = await deps.db
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(inArray(users.id, ids));
    const url = await appLink(deps, `/a/${account.slug}/admin/plan`);
    for (const admin of admins) {
      const brand = await accountMailBrand(deps, account, admin.locale);
      const l = brand.locale;
      const v = {
        org: account.name,
        plan,
        product: brand.product,
        date: new Intl.DateTimeFormat(l === 'he' ? 'he-IL' : 'en-GB', {
          dateStyle: 'long',
          timeZone: 'Asia/Jerusalem',
        }).format(s.periodEnd),
      };
      try {
        await deps.mailer.send(
          noticeEmail({
            to: admin.email,
            brand,
            subject: st('plan.renewal.mail.subject', v, l),
            title: st('plan.renewal.mail.subject', v, l),
            lines: [st('plan.renewal.mail.body', v, l)],
            cta: { label: st('plan.paid.cta', v, l), url },
            reason: st('signup.trial.reason', v, l),
          }),
        );
        sent++;
      } catch (err) {
        deps.logger.warn({ err, account: account.id }, 'renewal reminder email failed');
      }
    }
  }
  return sent;
};
