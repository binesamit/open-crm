// SPDX-License-Identifier: AGPL-3.0-only
import { inArray } from 'drizzle-orm';
import {
  type ErrorAlertRule,
  type ErrorHubSettings,
  type ErrorMute,
  ERROR_SEVERITIES,
  type ErrorSeverity,
  type Locale,
  OPEN_ERROR_STATUSES,
  atLeast,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import { users } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AppDeps } from '../../types';
import { notifyUsers } from '../notifications/notify';
import { platformMailBrand } from '../platform/mail-brand';
import { webOrigin } from '../platform/public-address';
import { listAgents } from '../tickets/tickets.repo';
import {
  activeAdminIds,
  alertedSince,
  type ErrorEventRow,
  errorsOverThreshold,
  insertAlert,
  platformOwners,
} from './errors.repo';
import { loadErrorHubSettings } from './errors.settings';

/**
 * Alerts of the errors hub, all from the settings: each rule (sources, minimum severity, account
 * threshold per window) fires `instant`ly (checked every minute) or in the daily `digest` (at the settings' hour and
 * zone). A rule fires once per error per window (dedupe); muted errors and mute rules stay quiet. Recipients: the
 * whole support team by default (decision 1), the owners, or chosen people — the console's bell (the alert row)
 * and / or email. The account's own admins get a bell + email only when the owner turned it on (answer 2).
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;
type Hit = { e: ErrorEventRow; occurrences: number; accountName: string | null };

const HOUR = 3_600_000;
const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;
/** The window's first hour bucket: "the last N hours" counts the current hour and the N−1 before it. */
const windowStart = (now: Date, hours: number) => new Date(hourStart(now.getTime()) - (hours - 1) * HOUR);

const severitiesFrom = (min: ErrorSeverity) => ERROR_SEVERITIES.filter((s) => atLeast(s, min));

export const muteMatches = (m: ErrorMute, e: ErrorEventRow, now: Date) =>
  new Date(m.until) > now &&
  (!m.source || m.source === e.source) &&
  (!m.account_id || m.account_id === e.accountId) &&
  (!m.text || `${e.code} ${e.message}`.toLowerCase().includes(m.text.toLowerCase()));

const notMuted = (settings: ErrorHubSettings, now: Date) => (h: Hit) =>
  !settings.alerts.mutes.some((m) => muteMatches(m, h.e, now));

type Person = { id: string; email: string; name: string; locale: string | null };

/** Who a rule reaches: the support team (staff + owners), the owners, or the chosen people among them. */
export const recipientsOf = async (deps: Pick<Deps, 'db'>, rule: Pick<ErrorAlertRule, 'audience' | 'user_ids'>) => {
  const team =
    rule.audience === 'owners'
      ? (await platformOwners(deps.db)).map((o) => ({ id: o.id, email: o.email, name: o.name || o.email }))
      : await listAgents(deps.db);
  const chosen = rule.audience === 'people' ? team.filter((p) => rule.user_ids.includes(p.id)) : team;
  if (!chosen.length) return [] as Person[];
  const locales = new Map(
    (
      await deps.db
        .select({ id: users.id, locale: users.locale })
        .from(users)
        .where(
          inArray(
            users.id,
            chosen.map((p) => p.id),
          ),
        )
    ).map((u) => [u.id, u.locale]),
  );
  return chosen.map((p) => ({ id: p.id, email: p.email, name: p.name, locale: locales.get(p.id) ?? null }));
};

const lineOf = (h: Hit, locale: Locale) =>
  st(
    'errors.mail.line',
    {
      source: st(`errors.source.${h.e.source}`, undefined, locale),
      severity: st(`errors.severity.${h.e.severity}`, undefined, locale),
      account: h.accountName ?? st('errors.platform', undefined, locale),
      code: h.e.code,
      message: h.e.message,
      count: h.occurrences,
    },
    locale,
  );

/** Emails one alert to its recipients (each in their language); failures are logged, never thrown. */
const emailAlert = async (deps: Deps, to: Person[], ruleName: string, hits: Hit[], firstId: string) => {
  const origin = await webOrigin(deps);
  for (const person of to) {
    try {
      const brand = await platformMailBrand(deps, person.locale);
      const vars = { rule: ruleName, count: hits.length, product: brand.product };
      await deps.mailer.send(
        noticeEmail({
          to: person.email,
          brand,
          subject: st('errors.mail.subject', vars, brand.locale),
          title: st('errors.mail.title', vars, brand.locale),
          hero: {
            kind: 'count',
            n: String(hits.length),
            unit: st('mail.obj.count.errors', vars, brand.locale),
            tone: 'bad',
          },
          lines: hits.slice(0, 20).map((h) => lineOf(h, brand.locale)),
          cta: {
            label: st('errors.mail.cta', vars, brand.locale),
            url: `${origin}/owner?section=errors${hits.length === 1 ? `&error=${firstId}` : ''}`,
          },
          reason: st('errors.mail.reason', { ...vars, email: person.email }, brand.locale),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err: String(err) }, 'errors hub: alert email failed');
    }
  }
};

const fire = async (
  deps: Deps,
  rule: ErrorAlertRule,
  mode: 'instant' | 'digest',
  hits: Hit[],
  dedupe: (h: Hit) => string,
  extraKey?: string,
) => {
  if (!hits.length) return 0;
  const to = await recipientsOf(deps, rule);
  // One row per error (dedupe per rule × error × window), so the bell can say what each was about.
  for (const h of hits)
    await insertAlert(deps.db, {
      ruleId: rule.id,
      ruleName: rule.name,
      mode,
      accountId: h.e.accountId,
      eventIds: [h.e.id],
      total: h.occurrences,
      recipients: rule.channels.bell ? to.map((p) => p.id) : [],
      dedupeKey: dedupe(h),
    });
  if (extraKey)
    await insertAlert(deps.db, {
      ruleId: rule.id,
      ruleName: rule.name,
      mode,
      accountId: null,
      eventIds: [],
      total: 0,
      recipients: [],
      dedupeKey: extraKey,
    });
  if (rule.channels.email) await emailAlert(deps, to, rule.name, hits, hits[0]!.e.id);
  return hits.length;
};

const matching = (deps: Deps, rule: ErrorAlertRule, now: Date, since: Date) =>
  errorsOverThreshold(deps.db, {
    since,
    threshold: rule.threshold,
    sources: rule.sources,
    severities: severitiesFrom(rule.min_severity),
    accountId: rule.account_id,
    statuses: [...OPEN_ERROR_STATUSES],
    now,
  });

/** Every minute: the instant rules. Returns how many errors were alerted. */
export const runInstantAlerts = async (deps: Deps, now = new Date()) => {
  const settings = await loadErrorHubSettings(deps.db);
  let n = 0;
  for (const rule of settings.alerts.rules.filter((r) => r.enabled && r.mode === 'instant')) {
    const since = windowStart(now, rule.window_hours);
    const hits: Hit[] = [];
    for (const h of (await matching(deps, rule, now, since)).filter(notMuted(settings, now)))
      if (
        !(await alertedSince(deps.db, `rule:${rule.id}:${h.e.id}`, new Date(now.getTime() - rule.window_hours * HOUR)))
      )
        hits.push(h);
    n += await fire(deps, rule, 'instant', hits, (h) => `rule:${rule.id}:${h.e.id}`);
  }
  n += await runAccountAlerts(deps, settings, now);
  return n;
};

/** The hour of `now` in a zone (0–23); an unknown zone counts as UTC. */
export const localHour = (now: Date, timeZone: string) => {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  } catch {
    return now.getUTCHours();
  }
};
const localDay = (now: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** Hourly: at the digest hour (settings' zone), each digest rule sends what passed its threshold in its window, once a day. */
export const runDigests = async (deps: Deps, now = new Date()) => {
  const settings = await loadErrorHubSettings(deps.db);
  const { timezone, digest_hour } = settings.alerts;
  if (localHour(now, timezone) !== digest_hour) return 0;
  const day = localDay(now, timezone);
  let n = 0;
  for (const rule of settings.alerts.rules.filter((r) => r.enabled && r.mode === 'digest')) {
    const key = `digest:${rule.id}:${day}`;
    if (await alertedSince(deps.db, key, new Date(now.getTime() - 26 * HOUR))) continue;
    const hits = (await matching(deps, rule, now, windowStart(now, rule.window_hours))).filter(notMuted(settings, now));
    if (!hits.length) continue;
    n += await fire(deps, rule, 'digest', hits, (h) => `digest:${rule.id}:${day}:${h.e.id}`, key);
  }
  return n;
};

/**
 * The account's own admins (off by default — decision 2): errors of the sources its Health page shows, past
 * the owner's threshold, once per error per window — a bell notification (type `error_alert`, emailed by the
 * notification worker like any other) that opens the Health page.
 */
const runAccountAlerts = async (deps: Deps, settings: ErrorHubSettings, now: Date) => {
  const page = settings.account_page;
  if (!page.enabled || !page.admin_alerts.enabled || !page.sources.length) return 0;
  const a = page.admin_alerts;
  const hits = (
    await errorsOverThreshold(deps.db, {
      since: windowStart(now, a.window_hours),
      threshold: a.threshold,
      sources: page.sources,
      severities: severitiesFrom(a.min_severity),
      accountId: null,
      statuses: [...OPEN_ERROR_STATUSES],
      now,
    })
  ).filter((h) => h.e.accountId && notMuted(settings, now)(h));
  let n = 0;
  for (const h of hits) {
    const key = `account:${h.e.id}`;
    if (await alertedSince(deps.db, key, new Date(now.getTime() - a.window_hours * HOUR))) continue;
    const admins = await activeAdminIds(deps.db, h.e.accountId!);
    await insertAlert(deps.db, {
      ruleId: 'account',
      ruleName: 'account',
      mode: 'account',
      accountId: h.e.accountId,
      eventIds: [h.e.id],
      total: h.occurrences,
      recipients: [],
      dedupeKey: key,
    });
    await notifyUsers(
      deps.db,
      {
        accountId: h.e.accountId!,
        type: 'error_alert',
        actorId: null,
        payload: {
          // The bell shows the excerpt; the click opens Administration → Health.
          excerpt: `${h.e.code}: ${h.e.message}`,
          error: {
            id: h.e.id,
            source: h.e.source,
            severity: h.e.severity,
            code: h.e.code,
            message: h.e.message,
            count: h.occurrences,
          },
        },
      },
      admins,
    );
    n++;
  }
  return n;
};
