// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  DEFAULT_TEST_EMAILS_PER_HOUR,
  type EmailPreview,
  type EmailPreviewQuery,
  type SendTestEmail,
  type TestEmailResult,
} from '@bines/shared';
import { asTestEmail, mailAllowed, sampleEmail } from '@bines/server-mail';
import { RateLimiter } from '../../lib/rate-limit';
import type { AppDeps, Actor } from '../../types';
import { accountMailBrand } from '../platform/mail-brand';
import { loadPlatformSettings } from '../platform/platform-settings';
import { webOrigin } from '../platform/public-address';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Administration → Emails & SMS (M11): how the account's emails look — any template with sample data, in either
 * language, with the account's saved brand (or an accent being tried) — and a test send to the admin's own address.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'mailer' | 'logger'>;
const render = async (deps: Deps, a: Actor, q: EmailPreviewQuery) => {
  const brand = await accountMailBrand(deps, a.ctx.account, q.locale);
  if (q.accent) brand.accent = q.accent.toLowerCase();
  if (q.style) brand.style = q.style;
  const mail = sampleEmail(q.template, {
    to: a.user.email,
    brand,
    appUrl: await webOrigin(deps),
    accountName: a.ctx.account.name,
  });
  return { brand, mail };
};

/** GET /accounts/me/email-preview (admins). */
export const previewEmail = async (deps: Deps, a: Actor, q: EmailPreviewQuery): Promise<EmailPreview> => {
  assertAccountAdmin(a.ctx);
  const { mail } = await render(deps, a, q);
  return {
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    from_name: mail.fromName ?? '',
    reply_to: mail.replyTo ?? null,
  };
};

/** Test sends per admin per hour (owner console → Platform settings; default DEFAULT_TEST_EMAILS_PER_HOUR). */
const testSends = new RateLimiter(Number.MAX_SAFE_INTEGER, 60 * 60 * 1000);

/**
 * POST /accounts/me/email-test (admins): the chosen email, marked as a test, to the admin's own address only.
 * Staging: an address off MAIL_ALLOWLIST is reported (`skipped`), and nothing is sent.
 */
export const sendTestEmail = async (deps: Deps, a: Actor, input: SendTestEmail): Promise<TestEmailResult> => {
  assertAccountAdmin(a.ctx);
  const to = a.user.email;
  const allowlist = deps.env.MAIL_ALLOWLIST?.trim();
  if (allowlist && !mailAllowed(allowlist, to)) return { to, sent: false, skipped: 'not_allowlisted' };
  const limit = (await loadPlatformSettings(deps.db)).email.test_emails_per_hour ?? DEFAULT_TEST_EMAILS_PER_HOUR;
  const { waitMs } = testSends.take(`${a.ctx.accountId}:${a.user.id}`, limit);
  if (waitMs > 0)
    throw new AppError('rate_limited', 'Too many test emails', { retry_after_ms: waitMs, limit_per_hour: limit });
  const { brand, mail } = await render(deps, a, input);
  try {
    await deps.mailer.send(asTestEmail(mail, brand));
  } catch (err) {
    deps.logger.error({ err, template: input.template }, 'test email failed');
    throw new AppError('unavailable', 'email_not_sent');
  }
  return { to, sent: true, skipped: null };
};
