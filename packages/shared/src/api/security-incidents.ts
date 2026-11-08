// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Security incident register (privacy — GDPR art. 33 / 34; Israel's data-security regulations
 * reg. 11): the platform owner records every security event — what happened, when it was detected, which accounts
 * and how many people, which data, what was done — and when the authority and the people were told. A personal
 * data breach must reach the supervisory authority within 72 hours of detection (GDPR art. 33(1)); a severe event
 * must be reported to Israel's Privacy Protection Authority at once.
 */
export const SECURITY_INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SecurityIncidentSeverity = (typeof SECURITY_INCIDENT_SEVERITIES)[number];
export const SECURITY_INCIDENT_STATUSES = ['open', 'contained', 'closed'] as const;
export type SecurityIncidentStatus = (typeof SECURITY_INCIDENT_STATUSES)[number];

/** Hours from detection to the authority's notice (GDPR art. 33(1)). */
export const BREACH_NOTICE_HOURS = 72;

const when = z.iso.datetime({ offset: true });

export const securityIncidentInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  severity: z.enum(SECURITY_INCIDENT_SEVERITIES),
  status: z.enum(SECURITY_INCIDENT_STATUSES).default('open'),
  personal_data: z.boolean().default(false),
  detected_at: when,
  occurred_at: when.nullable().optional(),
  account_ids: z.array(z.string().min(1).max(26)).max(500).default([]),
  people_affected: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  data_categories: z.string().max(2000).default(''),
  measures: z.string().max(20_000).default(''),
  authority_notified_at: when.nullable().optional(),
  authority_reference: z.string().trim().max(120).nullable().optional(),
  subjects_notified_at: when.nullable().optional(),
});
export type SecurityIncidentInput = z.infer<typeof securityIncidentInputSchema>;
export const securityIncidentPatchSchema = securityIncidentInputSchema.partial();
export type SecurityIncidentPatch = z.infer<typeof securityIncidentPatchSchema>;

export const securityIncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(SECURITY_INCIDENT_SEVERITIES),
  status: z.enum(SECURITY_INCIDENT_STATUSES),
  personal_data: z.boolean(),
  detected_at: z.string(),
  occurred_at: z.string().nullable(),
  account_ids: z.array(z.string()),
  people_affected: z.number().nullable(),
  data_categories: z.string(),
  measures: z.string(),
  authority_notified_at: z.string().nullable(),
  authority_reference: z.string().nullable(),
  subjects_notified_at: z.string().nullable(),
  /** detected_at + 72 h — when the authority's notice is due (personal data breaches). */
  authority_due_at: z.string().nullable(),
  /** A personal data breach past its 72 hours with no notice recorded. */
  overdue: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SecurityIncident = z.infer<typeof securityIncidentSchema>;
export const securityIncidentListSchema = z.object({ data: z.array(securityIncidentSchema) });

/** When the authority's notice is due, and whether it is late (a pure function: the API, the console, the job). */
export const breachDeadline = (
  i: { personal_data: boolean; detected_at: string; authority_notified_at: string | null },
  now = new Date(),
) => {
  if (!i.personal_data) return { due: null, overdue: false };
  const due = new Date(Date.parse(i.detected_at) + BREACH_NOTICE_HOURS * 3_600_000);
  return { due: due.toISOString(), overdue: !i.authority_notified_at && now.getTime() > due.getTime() };
};
