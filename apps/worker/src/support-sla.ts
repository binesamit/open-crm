// SPDX-License-Identifier: AGPL-3.0-only
import { mailBrand, noticeEmail } from '@bines/server-mail';
import { DEFAULT_LOCALE, helpdeskSettingsSchema, isLocale, type MessageKey, t } from '@bines/shared';
import { platformSettingsRow } from './repositories/notifications.repo';
import { breachRecipients, dueBreaches, helpdeskSettingsRow, markBreachAlerted } from './repositories/support.repo';
import type { SqlClient } from './repositories/trash.repo';
import type { MailDeps } from './notifications';

const tk = (key: string, vars: Record<string, string | number>, locale: 'he' | 'en') =>
  t(key as MessageKey, vars, locale);

/**
 * `support.sla` (every 5 minutes; stage 5): each SLA deadline that passed on a ticket still being
 * worked is announced once — to the assignee, else to every lead and platform owner — when the owner console says
 * so (`email.staff_on_breach`, default on). Marked even when the emails are off, so turning them on never floods.
 */
export const alertSlaBreaches = async (db: SqlClient, deps: MailDeps, now = new Date()) => {
  const parsed = helpdeskSettingsSchema.safeParse(await helpdeskSettingsRow(db));
  const settings = parsed.success ? parsed.data : helpdeskSettingsSchema.parse({});
  const platform = await platformSettingsRow(db);
  let sent = 0;
  for (const b of await dueBreaches(db, now)) {
    if (settings.email.staff_on_breach)
      for (const to of await breachRecipients(db, b.assignee_id)) {
        const lang = (to.locale ?? '').slice(0, 2);
        const locale = isLocale(lang) ? lang : DEFAULT_LOCALE;
        const brand = mailBrand({ locale, platform });
        const vars = { number: b.number, subject: b.subject, account: b.account_name, product: brand.product };
        for (const kind of [...(b.first ? ['first'] : []), ...(b.resolution ? ['resolution'] : [])]) {
          await deps.mailer.send(
            noticeEmail({
              to: to.email,
              brand,
              subject: tk(`tickets.mail.breach.${kind}.subject`, vars, locale),
              title: tk(`tickets.mail.breach.${kind}.subject`, vars, locale),
              lines: [tk(`tickets.mail.breach.${kind}.body`, vars, locale)],
              cta: {
                label: tk('tickets.mail.openConsole', vars, locale),
                url: `${deps.appUrl}/owner?section=support&ticket=${b.id}`,
              },
              reason: tk('tickets.mail.reason', { ...vars, email: to.email }, locale),
            }),
          );
          sent++;
        }
      }
    await markBreachAlerted(db, b.id, { first: b.first, resolution: b.resolution }, now);
  }
  return sent;
};
