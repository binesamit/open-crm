// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { type BillingSettings, subscriptionStateAt, type TrialEmailKind, type TrialEmails } from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import { accounts, accountSubscriptions, trialEmailsSent, users } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AppDeps } from '../../types';
import { loadBillingSettings } from '../billing/billing-settings';
import { activeAdminIds } from '../billing/plans.repo';
import { accountMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { loadSignupSettings } from './signup.store';

/**
 * Trial emails of self sign-up accounts (D32 decision 6, plan ה5): welcome at once, two reminders before the trial
 * ends, "ended — read-only", and a warning some days before read-only becomes suspended. Each email has its own
 * switch, days and (optional) text in the sign-up settings; they go to the account's admins, in each admin's
 * language with the account's brand, with an "upgrade" button to My plan. `sendDueTrialEmails` runs every hour
 * (and right after an account is created, for the welcome); `trial_emails_sent` makes each email go at most once
 * per subscription — a reminder overtaken by a later one is recorded as passed over, never sent late.
 */

type Deps = Pick<AppDeps, 'db' | 'env' | 'mailer' | 'logger'>;
type Sub = typeof accountSubscriptions.$inferSelect;
const DAY = 86_400_000;

/** What one subscription should get now: at most one email per run (the next run sends what follows). */
export const dueTrialEmail = (
  sub: Pick<Sub, 'status' | 'statusSince' | 'trialEndsAt' | 'periodEnd' | 'cancelAtPeriodEnd' | 'trialEndStatus'>,
  emails: TrialEmails,
  billing: BillingSettings,
  done: ReadonlySet<TrialEmailKind>,
  now: Date,
): { send: TrialEmailKind | null; skip: TrialEmailKind[] } => {
  const end = sub.trialEndsAt;
  if (sub.status !== 'trial' || !end) return { send: null, skip: [] };
  const open = (k: TrialEmailKind) => emails[k].enabled && !done.has(k);
  const skip: TrialEmailKind[] = [];
  const at = (days: number | null, moment: Date) => new Date(moment.getTime() - (days ?? 0) * DAY);
  if (now < end) {
    if (open('welcome')) return { send: 'welcome', skip };
    const last = open('reminder_last') && now >= at(emails.reminder_last.days, end);
    if (last) return { send: 'reminder_last', skip: open('reminder_first') ? ['reminder_first'] : [] };
    if (open('reminder_first') && now >= at(emails.reminder_first.days, end)) return { send: 'reminder_first', skip };
    return { send: null, skip };
  }
  // The trial is over: what was meant for before it never goes late.
  for (const k of ['welcome', 'reminder_first', 'reminder_last'] as const) if (open(k)) skip.push(k);
  const state = subscriptionStateAt(sub, billing, now);
  if (state.status !== 'read_only') {
    // Suspended already, or a trial that ends active / past due: the "read-only" emails do not apply.
    for (const k of ['ended', 'before_suspend'] as const) if (open(k)) skip.push(k);
    return { send: null, skip };
  }
  if (open('ended')) return { send: 'ended', skip };
  // Read-only by its own rule becomes suspended `read_only_days` after the end (closed never by itself).
  const own = sub.trialEndStatus === 'read_only';
  if (own && billing.read_only_days !== null && open('before_suspend')) {
    const suspendAt = new Date(end.getTime() + billing.read_only_days * DAY);
    if (now >= at(emails.before_suspend.days, suspendAt)) return { send: 'before_suspend', skip };
  }
  return { send: null, skip };
};

/** The days an email speaks of: until the trial ends (reminders) or until suspension (before_suspend). */
const daysLeft = (kind: TrialEmailKind, sub: Sub, billing: BillingSettings, now: Date) => {
  const end = sub.trialEndsAt!.getTime();
  const moment = kind === 'before_suspend' ? end + (billing.read_only_days ?? 0) * DAY : end;
  return Math.max(1, Math.ceil((moment - now.getTime()) / DAY));
};

const mailTo = async (
  deps: Deps,
  kind: TrialEmailKind,
  account: { id: string; name: string; slug: string; logoAssetId: string | null },
  emails: TrialEmails,
  days: number,
) => {
  const ids = await activeAdminIds(deps.db, account.id);
  if (!ids.length) return 0;
  const admins = await deps.db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, ids));
  const url = await appLink(deps, `/a/${account.slug}/admin/plan`);
  let sent = 0;
  for (const admin of admins) {
    const brand = await accountMailBrand(deps, account, admin.locale);
    const l = brand.locale;
    const v = { org: account.name, product: brand.product, days };
    const own = emails[kind][l === 'en' ? 'en' : 'he'];
    // The owner's own text (console), else the catalog's; {days} / {org} / {product} filled in either way.
    const fill = (text: string) => text.replace(/\{(days|org|product)\}/g, (_, k: keyof typeof v) => String(v[k]));
    const subject = own.subject ? fill(own.subject) : st(`signup.trial.${kind}.subject`, v, l);
    const body = own.body ? fill(own.body) : st(`signup.trial.${kind}.body`, v, l);
    try {
      await deps.mailer.send(
        noticeEmail({
          to: admin.email,
          brand,
          subject,
          title: subject,
          hero:
            kind === 'welcome'
              ? { kind: 'poster', badge: st('mail.obj.poster.badge', v, l) }
              : kind === 'ended'
                ? { kind: 'vitrine', label: st('mail.obj.vitrine.label', v, l) }
                : {
                    kind: 'calendar',
                    n: days,
                    head: st(kind === 'before_suspend' ? 'mail.obj.cal.suspend' : 'mail.obj.cal.head', v, l),
                    unit: st('mail.obj.cal.unit', v, l),
                  },
          lines: body.split(/\n+/).filter(Boolean),
          cta: { label: st('signup.trial.cta', v, l), url },
          reason: st('signup.trial.reason', v, l),
        }),
      );
      sent++;
    } catch (err) {
      deps.logger.warn({ err, kind, account: account.id }, 'trial email failed');
    }
  }
  return sent;
};

/**
 * Sends what is due now to every self sign-up account on a trial (or only `accountId`'s). Idempotent: the row is
 * claimed before sending (a second run at the same time finds it taken). Returns how many emails went out.
 */
export const sendDueTrialEmails = async (deps: Deps, now = new Date(), only?: { accountId: string }) => {
  const { emails } = await loadSignupSettings(deps.db);
  const billing = await loadBillingSettings(deps.db);
  const rows = await deps.db
    .select({ sub: accountSubscriptions, account: accounts })
    .from(accountSubscriptions)
    .innerJoin(accounts, eq(accounts.id, accountSubscriptions.accountId))
    .where(
      and(
        isNull(accountSubscriptions.endedAt),
        eq(accountSubscriptions.status, 'trial'),
        isNotNull(accountSubscriptions.trialEndsAt),
        eq(accounts.origin, 'signup'),
        isNull(accounts.deletedAt),
        ...(only ? [eq(accounts.id, only.accountId)] : []),
      ),
    );
  if (!rows.length) return 0;
  const done = await deps.db
    .select()
    .from(trialEmailsSent)
    .where(
      inArray(
        trialEmailsSent.subscriptionId,
        rows.map((r) => r.sub.id),
      ),
    );
  let total = 0;
  for (const { sub, account } of rows) {
    const mine = new Set(done.filter((d) => d.subscriptionId === sub.id).map((d) => d.kind as TrialEmailKind));
    const { send, skip } = dueTrialEmail(sub, emails, billing, mine, now);
    if (skip.length)
      await deps.db
        .insert(trialEmailsSent)
        .values(skip.map((kind) => ({ subscriptionId: sub.id, kind, sent: false, sentAt: now })))
        .onConflictDoNothing();
    if (!send) continue;
    const claimed = await deps.db
      .insert(trialEmailsSent)
      .values({ subscriptionId: sub.id, kind: send, sentAt: now })
      .onConflictDoNothing()
      .returning({ kind: trialEmailsSent.kind });
    if (!claimed.length) continue;
    total += await mailTo(deps, send, account, emails, daysLeft(send, sub, billing, now));
  }
  return total;
};
