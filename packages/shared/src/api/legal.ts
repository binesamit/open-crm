// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** A short text in both languages (a sub-processor's purpose). */
const localizedText = (max: number) =>
  z.object({ he: z.string().trim().min(1).max(max), en: z.string().trim().min(1).max(max) });

/**
 * Legal documents: terms, privacy, acceptable use, cookies, licenses, AI & ethics — written by the
 * platform owner (owner console), versioned, in both UI languages (Markdown), served on public pages
 * (`/legal/<slug>`). A document marked "requires consent" is accepted by every person once per published version.
 * Nothing in them is a literal of one operator: `{{company_name}}` … are filled from platform settings → `legal`.
 */
export const LEGAL_LOCALES = ['he', 'en'] as const;
export type LegalLocale = (typeof LEGAL_LOCALES)[number];

/** The documents every platform ships with (defaults are seeded once; the owner may add more). */
export const DEFAULT_LEGAL_SLUGS = [
  'terms',
  'privacy',
  'acceptable-use',
  'cookies',
  'licenses',
  'ai-ethics',
  // the accessibility statement the law requires (Israeli Standard 5568), linked from every screen.
  'accessibility',
  'dpa',
  // what an account agrees to when it buys (accepted at checkout), and the drafts the owner publishes
  // when they apply (SLA, extension developers, security and disclosure, copyright notices).
  'subscription',
  'sla',
  'developer-terms',
  'security',
  'copyright',
] as const;

/** Placeholders a document may use; empty settings render as a visible `[name]` marker. */
export const LEGAL_PLACEHOLDERS = [
  'company_name',
  'company_legal_name',
  'company_id',
  'company_address',
  'contact_email',
  'privacy_email',
  'dpo_name',
  'dpo_email',
  'accessibility_coordinator',
  'accessibility_phone',
  'accessibility_email',
  // the operator's choice of law and courts (terms, copyright counter-notice) — no country is assumed.
  'governing_law',
  'courts_location',
  'product_name',
  'site_url',
  'last_updated',
  // filled from the billing settings (owner console → Plans → settings), so the subscription terms say
  // what the cancel screen computes.
  'cooling_off_days',
  'cancel_fee_pct',
  'cancel_fee_cap',
  'renewal_reminder_days',
  'change_notice_days',
] as const;
/** Placeholders that may legitimately be empty (no DPO appointed): they render as nothing, not as a marker. */
export const OPTIONAL_LEGAL_PLACEHOLDERS = ['dpo_name', 'dpo_email'] as const;

/**
 * A sub-processor (GDPR art. 28; privacy): a service that processes personal data on the operator's
 * behalf — hosting, files, mail, SMS, sign-in, AI. The owner keeps the list in the console; it is published at
 * `/legal/sub-processors` in both languages (the privacy policy may link to it).
 */
export const subProcessorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** What it does for the service ("hosting and database", "transactional email"). */
  purpose: localizedText(300),
  /** Where the data is kept ("EU (Frankfurt)", "USA"). */
  location: z.string().trim().min(1).max(120),
  /** The provider's data-processing terms, when published. */
  dpa_url: z.string().trim().url().max(500).optional(),
});
export type SubProcessor = z.infer<typeof subProcessorSchema>;
export const subProcessorsListSchema = z.object({ data: z.array(subProcessorSchema) });
export type SubProcessorsList = z.infer<typeof subProcessorsListSchema>;

export const legalSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const localized = <T extends z.ZodTypeAny>(s: T) => z.object({ he: s, en: s });
export const legalTitleSchema = z.string().trim().min(1).max(120);
export const legalBodySchema = z.string().max(100_000);

export const legalTextsSchema = z.object({
  title: localized(legalTitleSchema),
  body: localized(legalBodySchema),
});
export type LegalTexts = z.infer<typeof legalTextsSchema>;

/** A published document in the public list (sign-in footer, help menu, the /legal index). */
export const legalDocSummarySchema = z.object({
  slug: z.string(),
  title: localized(z.string()),
  version: z.number().int(),
  published_at: z.string(),
  requires_consent: z.boolean(),
  /** Accepted when an account buys a plan: the checkout asks for it, joining does not. */
  purchase_consent: z.boolean(),
});
export type LegalDocSummary = z.infer<typeof legalDocSummarySchema>;

/** GET /legal: the published documents, and how joining asks for consent (platform setting). */
export const legalListSchema = z.object({
  data: z.array(legalDocSummarySchema),
  /** true = joining needs a ticked checkbox; false = "by joining you agree …" next to the button. */
  consent_checkbox: z.boolean(),
  /** The data protection officer (privacy), when the owner named one — shown on the legal pages. */
  dpo: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
  /** The owner published a sub-processors list (`GET /legal/sub-processors`): the pages link to it. */
  sub_processors: z.boolean(),
  /** The notice shown where people sign up (privacy — Israel Privacy Law §11); null = none. */
  collection_notice: z.object({ he: z.string().nullable(), en: z.string().nullable() }),
  /**
   * The marketing opt-in offered at sign-up (Israel Communications Law §30A: a separate, unticked
   * box); null = not offered. The texts are the box's label.
   */
  marketing_opt_in: z.object({ he: z.string(), en: z.string() }).nullable(),
});
export type LegalList = z.infer<typeof legalListSchema>;

/** GET /legal/{slug}: one published version rendered to safe HTML, placeholders filled. */
export const legalDocViewSchema = z.object({
  slug: z.string(),
  locale: z.enum(LEGAL_LOCALES),
  title: z.string(),
  html: z.string(),
  headings: z.array(z.object({ depth: z.number().int(), id: z.string(), text: z.string() })),
  version: z.number().int(),
  published_at: z.string(),
  requires_consent: z.boolean(),
  /** Every published document, for the page's navigation. */
  documents: z.array(legalDocSummarySchema),
});
export type LegalDocView = z.infer<typeof legalDocViewSchema>;

export const legalDocViewQuerySchema = z.object({
  locale: z.enum(LEGAL_LOCALES).optional(),
  /** Owner only: an older published version. */
  version: z.coerce.number().int().min(1).optional(),
});

/** Owner console: a document with its working draft and what is published. */
export const legalDocAdminSchema = z.object({
  id: z.string(),
  slug: z.string(),
  sort_order: z.number().int(),
  requires_consent: z.boolean(),
  purchase_consent: z.boolean(),
  draft: legalTextsSchema,
  /** The draft differs from the published version. */
  draft_changed: z.boolean(),
  published_version: z.number().int().nullable(),
  published_at: z.string().nullable(),
  consents: z.number().int(),
  updated_at: z.string(),
});
export type LegalDocAdmin = z.infer<typeof legalDocAdminSchema>;

export const createLegalDocSchema = z.object({
  slug: legalSlugSchema,
  title: localized(legalTitleSchema),
});

export const updateLegalDocSchema = z.object({
  draft: z
    .object({
      title: z.object({ he: legalTitleSchema.optional(), en: legalTitleSchema.optional() }).optional(),
      body: z.object({ he: legalBodySchema.optional(), en: legalBodySchema.optional() }).optional(),
    })
    .optional(),
  requires_consent: z.boolean().optional(),
  purchase_consent: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
});
export type UpdateLegalDoc = z.infer<typeof updateLegalDocSchema>;

export const legalVersionSchema = z.object({
  version: z.number().int(),
  title: localized(z.string()),
  published_at: z.string(),
  published_by: z.string().nullable(),
  consents: z.number().int(),
  /** A material change asks everyone to accept again; a minor one (wording, a typo) does not. */
  material: z.boolean(),
});
export type LegalVersion = z.infer<typeof legalVersionSchema>;

/** POST /platform/legal/{slug}/publish: material (default) = people accept the new version again. */
export const publishLegalDocSchema = z.object({ material: z.boolean().default(true) });
export type PublishLegalDoc = z.infer<typeof publishLegalDocSchema>;

/** GET /platform/legal/consents.csv: who accepted what (one document, or all of them). */
export const legalConsentsExportQuerySchema = z.object({ slug: legalSlugSchema.optional() });

/** A version a person accepts (sign-up checkbox, or the "terms were updated" prompt). */
export const legalAcceptanceSchema = z.object({ slug: legalSlugSchema, version: z.number().int().min(1) });
export type LegalAcceptance = z.infer<typeof legalAcceptanceSchema>;

export const acceptLegalSchema = z.object({ accepted: z.array(legalAcceptanceSchema).min(1).max(20) });

/** GET /me/legal: the published "requires consent" versions this person has not accepted yet. */
export const myLegalSchema = z.object({ pending: z.array(legalDocSummarySchema) });
export type MyLegal = z.infer<typeof myLegalSchema>;
