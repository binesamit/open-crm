// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { AppError, isLocale, type UpgradeRequest } from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import { users } from '../../db/schema';
import { assertAccountAdmin } from '../../lib/account-admin';
import { st } from '../../lib/i18n';
import { RateLimiter } from '../../lib/rate-limit';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { platformMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { loadHelpdeskSettings } from '../tickets/tickets.settings';
import { createTicket } from '../tickets/tickets.service';
import { listPublicPlans } from './plans.service';

type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger' | 'storage' | 'auth'>;
type Actor = { ctx: AccountContext; user: SessionUser; requestId?: string };

/** A few requests per account per hour: one click is enough, a loop is not a way to page the owner. */
const limiter = new RateLimiter(3, 60 * 60_000);
export const forgetUpgradeRequestLimits = () => limiter.clear();

/**
 * POST /plan/upgrade-request (self sign-up ה5, decision ⭐ in א5): an admin asks to move to a plan. A ticket at the
 * platform's support desk when it is on (the request is followed there, its staff hear of it as of any ticket),
 * otherwise an email to the platform owners. Works while the account is read-only or suspended (the status gate lets admins reach /plan).
 */
export const requestUpgrade = async (deps: Deps, a: Actor, input: UpgradeRequest) => {
  assertAccountAdmin(a.ctx);
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
  if (limiter.hit(a.ctx.accountId)) throw new AppError('rate_limited', 'upgrade_request_rate_limited');
  const plans = (await listPublicPlans(deps.db)).data;
  const plan = input.plan_id ? plans.find((p) => p.id === input.plan_id) : undefined;
  if (input.plan_id && !plan) throw new AppError('invalid_value', 'plan_not_found');
  const account = a.ctx.account;
  const vars = {
    org: account.name,
    slug: account.slug,
    email: a.user.email,
    plan: plan?.name ?? '—',
    note: input.note ?? '',
  };

  let ticketId: string | null = null;
  if ((await loadHelpdeskSettings(deps.db)).enabled) {
    try {
      // The ticket reads in the requester's language (the desk shows the account's tickets as written).
      const own = (a.user as { locale?: string | null }).locale;
      const locale = isLocale(own) ? own : undefined;
      const t = await createTicket(deps, a, {
        subject: st('plan.upgradeRequest.ticket.subject', vars, locale),
        description: [st('plan.upgradeRequest.ticket.body', vars, locale), input.note].filter(Boolean).join('\n\n'),
        attachment_ids: [],
      });
      ticketId = (t as { id: string }).id;
    } catch (err) {
      // Who may open tickets is the account's setting: the owners still hear about it by email.
      deps.logger.info({ err, account: account.id }, 'upgrade request: no ticket');
    }
  }

  // With a ticket, the support desk tells its staff (as for any new ticket); without one, the owners get an email.
  const owners = ticketId
    ? []
    : await deps.db
        .select({ email: users.email, locale: users.locale })
        .from(users)
        .where(eq(users.isPlatformOwner, true));
  const url = await appLink(deps, '/owner');
  for (const o of owners) {
    const brand = await platformMailBrand(deps, o.locale);
    const l = brand.locale;
    const v = { ...vars, product: brand.product };
    try {
      await deps.mailer.send(
        noticeEmail({
          to: o.email,
          brand,
          subject: st('plan.upgradeRequest.mail.subject', v, l),
          title: st('plan.upgradeRequest.mail.subject', v, l),
          lines: [st('plan.upgradeRequest.mail.body', v, l), ...(input.note ? [input.note] : [])],
          cta: { label: st('plan.upgradeRequest.mail.cta', v, l), url },
          reason: st('plan.upgradeRequest.mail.reason', v, l),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err }, 'upgrade request email failed');
    }
  }
  await recordAudit(deps.db, {
    accountId: account.id,
    actorId: a.user.id,
    action: 'plan.upgrade_requested',
    targetType: 'account',
    targetId: account.id,
    payload: { plan_id: plan?.id ?? null, ticket_id: ticketId },
  });
  return { ok: true as const, ticket_id: ticketId };
};
