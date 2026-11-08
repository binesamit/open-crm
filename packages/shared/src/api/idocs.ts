// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idocSectionsSchema, idocSettingsSchema, IDOC_LIMITS, type IdocSection } from '../idocs/sections';
import type { IdocTotals } from '../idocs/totals';
import { consentEvidenceSchema } from './signatures';
import { idocThemeSchema } from '../idocs/theme';

/**
 * Interactive documents — the app's endpoints
 * - templates: `/idoc-templates` (account-wide, or tied to one board);
 * - documents: an item shared from a template (`/items/{id}/idocs`, `/idocs/{id}`), with its own copy of the
 *   sections and settings, a public link, status, version and the event log;
 * - the public page: `/public/idocs/{token}` (no account header; the token names the document).
 */

const id = z.string().min(1).max(26);

export const idocTemplateSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  /** Null = every board of the account may use it. */
  board_id: id.nullable(),
  sections: idocSectionsSchema,
  settings: idocSettingsSchema,
  created_by: id.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IdocTemplate = z.infer<typeof idocTemplateSchema>;

export const createIdocTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  board_id: id.nullable().optional(),
  /** Start from a built-in starter (templates.ts) or a copy of another template; else a blank one. */
  starter: z.string().max(64).optional(),
  from_template_id: id.optional(),
  /** Save a shared document's current sections and settings as a template. */
  from_doc_id: id.optional(),
});

export const updateIdocTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  board_id: id.nullable().optional(),
  sections: idocSectionsSchema.optional(),
  settings: idocSettingsSchema.optional(),
});

/** POST /idoc-templates/{id}/setup: create the columns the template needs on a board and map them. */
export const setupIdocTemplateSchema = z.object({ board_id: id });
export const setupIdocTemplateResultSchema = z.object({
  template: idocTemplateSchema,
  /** Columns made, by board ("item" board or its subitems board), with their titles. */
  created: z.array(
    z.object({ board: z.enum(['item', 'subitems']), key: z.string(), title: z.string(), type: z.string() }),
  ),
});

export const IDOC_STATUSES = ['draft', 'sent', 'viewed', 'signed', 'expired', 'revoked'] as const;
export type IdocStatus = (typeof IDOC_STATUSES)[number];

export const idocSignatureSummarySchema = z.object({
  id,
  name: z.string(),
  role: z.string().nullable(),
  at: z.string(),
  version: z.number().int(),
});

export const idocDocSchema = z.object({
  id,
  item_id: id,
  board_id: id,
  template_id: id.nullable(),
  name: z.string(),
  sections: idocSectionsSchema,
  settings: idocSettingsSchema,
  status: z.enum(IDOC_STATUSES),
  version: z.number().int(),
  /** The public page's address (only for people who can edit the item). */
  url: z.string().nullable(),
  expires_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  sent_to: z.string().nullable(),
  first_viewed_at: z.string().nullable(),
  last_viewed_at: z.string().nullable(),
  view_count: z.number().int(),
  signature: idocSignatureSummarySchema.nullable(),
  created_by: id.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IdocDoc = z.infer<typeof idocDocSchema>;

export const createIdocDocSchema = z.object({
  template_id: id.optional(),
  starter: z.string().max(64).optional(),
  name: z.string().trim().max(200).optional(),
});
export const updateIdocDocSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  sections: idocSectionsSchema.optional(),
  settings: idocSettingsSchema.optional(),
});
export const sendIdocDocSchema = z.object({
  /** Override of the contact's address (else the contact email column). */
  email: z.email().max(320).optional(),
  /** Mark as sent without an email (the sender shares the link themselves). */
  no_email: z.boolean().optional(),
});

export const IDOC_EVENT_KINDS = [
  'created',
  'sent',
  'opened',
  'verified',
  'selected',
  'input',
  'question',
  'signed',
  'reopened',
  'revoked',
  'link_replaced',
  'expired',
  /** The client downloaded the PDF. */
  'downloaded',
] as const;
export type IdocEventKind = (typeof IDOC_EVENT_KINDS)[number];

export const idocEventSchema = z.object({
  id,
  kind: z.enum(IDOC_EVENT_KINDS),
  at: z.string(),
  /** Who (a member's name, the client's name, or null). */
  who: z.string().nullable(),
  /** Short readable detail ("ticked 'WhatsApp'", "qty 5"). */
  detail: z.string(),
  ip: z.string().nullable(),
});
export type IdocEvent = z.infer<typeof idocEventSchema>;

/** GET /signatures/{id}: the certificate of a signature. */
export const idocCertificateSchema = z.object({
  id,
  doc_id: id,
  doc_name: z.string(),
  item_id: id,
  version: z.number().int(),
  sha256: z.string(),
  evidence: consentEvidenceSchema,
  /** The drawn signature as SVG path data, or null. */
  drawing: z.string().nullable(),
  /** Choices and totals as signed (readable summary lines). */
  summary: z.array(z.string()),
  events: z.array(idocEventSchema),
  /** The signed copy in the files column, if one was kept. */
  file_id: id.nullable(),
});
export type IdocCertificate = z.infer<typeof idocCertificateSchema>;

// ——— The public page ———

export const publicIdocRowSchema = z.object({
  /** Opaque per document (never an item id). */
  key: z.string(),
  name: z.string(),
  description: z.string(),
  price: z.number().nullable(),
  unit_price: z.number().nullable(),
  recurring_price: z.number().nullable(),
  recurring_unit_price: z.number().nullable(),
  qty: z.number().nullable(),
  selected: z.boolean(),
  requires: z.array(z.string()),
  /** Names of the required rows (for "needs …"). */
  requires_names: z.array(z.string()),
  unit: z.string(),
});
export type PublicIdocRow = z.infer<typeof publicIdocRowSchema>;

export const publicIdocInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'long_text', 'email', 'phone', 'number', 'date', 'checkbox', 'link']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  required: z.boolean(),
  help: z.string(),
});
export type PublicIdocInput = z.infer<typeof publicIdocInputSchema>;

export const publicIdocFileSchema = z.object({ ref: z.string(), name: z.string(), mime: z.string(), url: z.string() });
export const publicIdocPersonSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  photo_url: z.string().nullable(),
});
export const publicIdocDatedRowSchema = z.object({
  name: z.string(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  description: z.string(),
});

/** What a section brings besides its settings, resolved on the server for the viewer. */
export const publicIdocDataSchema = z.object({
  fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  rows: z.array(publicIdocRowSchema).optional(),
  inputs: z.array(publicIdocInputSchema).optional(),
  files: z.array(publicIdocFileSchema).optional(),
  people: z.array(publicIdocPersonSchema).optional(),
  dated: z.array(publicIdocDatedRowSchema).optional(),
  cover_url: z.string().nullable().optional(),
  sender_name: z.string().nullable().optional(),
});
export type PublicIdocData = z.infer<typeof publicIdocDataSchema>;

/**
 * A section as the page gets it: its settings (texts merged; column keys removed) plus `data`. Typed loosely on the
 * wire (the page reads it through `IdocSection`), validated as an object.
 */
export const publicIdocSectionSchema = z.looseObject({ id: z.string(), kind: z.string(), data: publicIdocDataSchema });
export type PublicIdocSection = IdocSection & { data: PublicIdocData };

/** A section with nothing to show (no rows, no text…): left out of the page and the PDF; the editor marks it. */
export const isEmptyIdocSection = (s: PublicIdocSection): boolean => {
  switch (s.kind) {
    case 'text':
      return !s.body.trim() && !s.body2.trim();
    case 'lines':
      return !(s.data.rows ?? []).length;
    case 'table':
      return !s.rows.length;
    case 'faq':
      return !s.items.length;
    case 'timeline':
      return !(s.data.dated ?? []).length;
    case 'media':
      return !(s.data.files ?? []).length && !(s.mode === 'video' && /^https?:\/\//.test(s.url));
    case 'fields':
      return !(s.data.fields ?? []).length;
    case 'people':
      return !(s.data.people ?? []).length;
    case 'inputs':
      return !(s.data.inputs ?? []).length;
    case 'summary':
      return !s.show_totals && !s.schedule.length;
    case 'cta':
      return !s.text.trim() && !s.button_label.trim();
    default:
      return false;
  }
};

export const publicIdocQuestionSchema = z.object({
  id: z.string(),
  section_id: z.string().nullable(),
  section_title: z.string(),
  /** `client` = asked on the page; `team` = written in the app. */
  from: z.enum(['client', 'team']),
  name: z.string(),
  text: z.string(),
  at: z.string(),
  replies: z.array(z.object({ from: z.enum(['client', 'team']), name: z.string(), text: z.string(), at: z.string() })),
});
export type PublicIdocQuestion = z.infer<typeof publicIdocQuestionSchema>;

export const publicIdocSchema = z.object({
  /** `verify` = a one-time code must be entered first (nothing else is sent). */
  state: z.enum(['open', 'signed', 'expired', 'revoked', 'verify']),
  title: z.string(),
  language: z.enum(['he', 'en']),
  version: z.number().int(),
  expires_at: z.string().nullable(),
  account: z.object({ name: z.string(), logo_url: z.string().nullable(), color: z.string() }),
  currency: z.string(),
  vat_percent: z.number(),
  prices_include_vat: z.boolean(),
  sections: z.array(publicIdocSectionSchema),
  questions: z.array(publicIdocQuestionSchema),
  signed: z.object({ name: z.string(), role: z.string().nullable(), at: z.string() }).nullable(),
  /** Where the code goes, masked ("ta***@pa***.co.il"), when `state` is `verify`. */
  email_hint: z.string().nullable(),
  /** The look for this viewer (the account's default for the audience, then the document's own). */
  theme: idocThemeSchema,
});
export type PublicIdoc = Omit<z.infer<typeof publicIdocSchema>, 'sections'> & { sections: PublicIdocSection[] };

export const publicIdocSelectSchema = z
  .object({
    section_id: z.string().max(64),
    /** One row — or, with `all`, every row of the section. */
    row: z.string().max(64).optional(),
    selected: z.boolean().optional(),
    qty: z.number().min(0).max(1_000_000).optional(),
    /** Select (true) or clear (false) every row of a free-choice section at once (its "select all" switch on). */
    all: z.boolean().optional(),
  })
  .refine((x) => (x.all === undefined) === !!x.row, { message: 'Give `row` or `all`' });
export const publicIdocSelectResultSchema = z.object({
  section_id: z.string(),
  rows: z.array(publicIdocRowSchema),
});

export const publicIdocInputsSchema = z.object({
  section_id: z.string().max(64),
  values: z.record(
    z.string().max(64),
    z.union([z.string().max(IDOC_LIMITS.cell * 5), z.number(), z.boolean(), z.null()]),
  ),
});

export const publicIdocAskSchema = z.object({
  section_id: z.string().max(64).nullable(),
  text: z.string().trim().min(1).max(4000),
  name: z.string().trim().max(200).optional(),
  /** Reply to an earlier question (its id). */
  parent_id: z.string().max(26).optional(),
});

export const publicIdocVerifyCheckSchema = z.object({ code: z.string().trim().min(4).max(10) });
export const publicIdocVerifyResultSchema = z.object({ visitor_key: z.string(), expires_at: z.string() });

/** Drawn signature: SVG path data only (M/L/Q/C commands and numbers), capped. */
export const IDOC_DRAWING_MAX = 60_000;
export const idocDrawingSchema = z
  .string()
  .max(IDOC_DRAWING_MAX)
  .regex(/^[MLQCZmlqcz0-9.,\s-]*$/);

export const publicIdocSignSchema = z.object({
  section_id: z.string().max(64),
  /** The signer's name — required (2+ characters) in "sign" mode; "approve" mode shows no name field, so it may be empty. */
  name: z.string().trim().max(200),
  role: z.string().trim().max(200).optional(),
  /** Keys of the boxes ticked. */
  consents: z.array(z.string().max(64)).max(IDOC_LIMITS.consents),
  drawing: idocDrawingSchema.optional(),
  /**
   * The signer typed their name as the signature instead of drawing (accessibility: no pointer needed). It satisfies
   * "a drawn signature is required" and is recorded as typed in the evidence.
   */
  typed: z.boolean().optional(),
  /** The version the page shows (a reopened document refuses a stale page). */
  version: z.number().int(),
});
export const publicIdocSignResultSchema = z.object({
  signed: z.object({ name: z.string(), role: z.string().nullable(), at: z.string() }),
  sha256: z.string(),
});

/** Mask an address for the "code sent to" hint. */
export const maskEmail = (email: string) => {
  const [user = '', domain = ''] = email.split('@');
  const keep = (s: string, n: number) => (s.length <= n ? s.slice(0, 1) : s.slice(0, n)) + '***';
  const dot = domain.indexOf('.');
  return `${keep(user, 2)}@${dot > 0 ? keep(domain.slice(0, dot), 2) + domain.slice(dot) : keep(domain, 2)}`;
};

export type { IdocTotals };
