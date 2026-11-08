// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull, lt, ne } from 'drizzle-orm';
import {
  AppError,
  BREACH_NOTICE_HOURS,
  breachDeadline,
  newId,
  type SecurityIncident,
  type SecurityIncidentInput,
  type SecurityIncidentPatch,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { Db } from '../../db/client';
import { securityIncidents, users, type SecurityIncidentRow } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AppDeps, SessionUser } from '../../types';
import { appLink } from './public-address';
import { platformMailBrand } from './mail-brand';

/**
 * The security incident register (privacy): owner-console CRUD and the reminder. Every change is in
 * the platform's own records (this table keeps who created it and when it changed); the register itself is the
 * documentation GDPR art. 33(5) and the data-security regulations ask for.
 */
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const at = (s: string | null | undefined) => (s ? new Date(s) : null);

export const incidentDto = (r: SecurityIncidentRow, now = new Date()): SecurityIncident => {
  const base = {
    personal_data: r.personalData,
    detected_at: r.detectedAt.toISOString(),
    authority_notified_at: iso(r.authorityNotifiedAt),
  };
  const deadline = breachDeadline(base, now);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    severity: r.severity as SecurityIncident['severity'],
    status: r.status as SecurityIncident['status'],
    ...base,
    occurred_at: iso(r.occurredAt),
    account_ids: r.accountIds,
    people_affected: r.peopleAffected,
    data_categories: r.dataCategories,
    measures: r.measures,
    authority_reference: r.authorityReference,
    subjects_notified_at: iso(r.subjectsNotifiedAt),
    authority_due_at: deadline.due,
    overdue: deadline.overdue,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
};

const columnsOf = (p: SecurityIncidentPatch) => ({
  ...(p.title !== undefined ? { title: p.title } : {}),
  ...(p.description !== undefined ? { description: p.description } : {}),
  ...(p.severity !== undefined ? { severity: p.severity } : {}),
  ...(p.status !== undefined ? { status: p.status } : {}),
  ...(p.personal_data !== undefined ? { personalData: p.personal_data } : {}),
  ...(p.detected_at !== undefined ? { detectedAt: new Date(p.detected_at) } : {}),
  ...(p.occurred_at !== undefined ? { occurredAt: at(p.occurred_at) } : {}),
  ...(p.account_ids !== undefined ? { accountIds: [...new Set(p.account_ids)] } : {}),
  ...(p.people_affected !== undefined ? { peopleAffected: p.people_affected } : {}),
  ...(p.data_categories !== undefined ? { dataCategories: p.data_categories } : {}),
  ...(p.measures !== undefined ? { measures: p.measures } : {}),
  ...(p.authority_notified_at !== undefined ? { authorityNotifiedAt: at(p.authority_notified_at) } : {}),
  ...(p.authority_reference !== undefined ? { authorityReference: p.authority_reference || null } : {}),
  ...(p.subjects_notified_at !== undefined ? { subjectsNotifiedAt: at(p.subjects_notified_at) } : {}),
});

export const listIncidents = async (db: Db) => ({
  data: (await db.select().from(securityIncidents).orderBy(desc(securityIncidents.detectedAt))).map((r) =>
    incidentDto(r),
  ),
});

export const createIncident = async (db: Db, owner: SessionUser, input: SecurityIncidentInput) => {
  const [row] = await db
    .insert(securityIncidents)
    .values({
      id: newId(),
      title: input.title,
      severity: input.severity,
      detectedAt: new Date(input.detected_at),
      ...columnsOf(input),
      createdBy: owner.id,
    })
    .returning();
  return incidentDto(row!);
};

export const updateIncident = async (db: Db, id: string, patch: SecurityIncidentPatch) => {
  const [row] = await db
    .update(securityIncidents)
    .set({ ...columnsOf(patch), updatedAt: new Date() })
    .where(eq(securityIncidents.id, id))
    .returning();
  if (!row) throw new AppError('not_found', 'Incident not found');
  return incidentDto(row);
};

export const deleteIncident = async (db: Db, id: string) => {
  const gone = await db
    .delete(securityIncidents)
    .where(eq(securityIncidents.id, id))
    .returning({ id: securityIncidents.id });
  if (!gone.length) throw new AppError('not_found', 'Incident not found');
  return { ok: true as const };
};

/** Hours before the 72-hour deadline when the owners are reminded once. */
export const REMIND_BEFORE_HOURS = 24;
export const INCIDENTS_REMIND_TASK = 'security.incidents_remind';

/**
 * Hourly: a personal data breach with no authority notice, 24 hours or less before its 72-hour deadline (or past
 * it), and not reminded yet → one email to every platform owner. Returns how many incidents were reminded.
 */
export const remindIncidents = async (deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>, now = new Date()) => {
  const threshold = new Date(now.getTime() - (BREACH_NOTICE_HOURS - REMIND_BEFORE_HOURS) * 3_600_000);
  const due = await deps.db
    .select()
    .from(securityIncidents)
    .where(
      and(
        eq(securityIncidents.personalData, true),
        isNull(securityIncidents.authorityNotifiedAt),
        isNull(securityIncidents.remindedAt),
        ne(securityIncidents.status, 'closed'),
        lt(securityIncidents.detectedAt, threshold),
      ),
    );
  if (!due.length) return 0;
  const owners = await deps.db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(and(eq(users.isPlatformOwner, true), eq(users.isService, false)));
  const url = await appLink(deps, '/owner');
  for (const r of due) {
    const d = incidentDto(r, now);
    for (const o of owners) {
      try {
        const brand = await platformMailBrand(deps, o.locale);
        const l = brand.locale;
        const v = { title: r.title, due: d.authority_due_at ?? '', product: brand.product };
        await deps.mailer.send(
          noticeEmail({
            to: o.email,
            brand,
            subject: st('incidents.mail.subject', v, l),
            title: st('incidents.mail.title', v, l),
            ...(d.authority_due_at
              ? {
                  hero: {
                    kind: 'count' as const,
                    n: String(Math.max(0, Math.ceil((Date.parse(d.authority_due_at) - now.getTime()) / 3_600_000))),
                    unit: st('mail.obj.count.hours', v, l),
                    tone: 'bad' as const,
                  },
                }
              : {}),
            lines: [st('incidents.mail.body', v, l)],
            cta: { label: st('incidents.mail.cta', v, l), url },
            reason: st('incidents.mail.reason', v, l),
          }),
        );
      } catch (err) {
        deps.logger.warn({ err, incidentId: r.id }, 'incident reminder email failed');
      }
    }
    await deps.db.update(securityIncidents).set({ remindedAt: now }).where(eq(securityIncidents.id, r.id));
  }
  return due.length;
};
