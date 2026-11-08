// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idocThemeSchema } from './theme';

/**
 * Interactive documents: an item shared as a live page made of sections. A section is one of a
 * small set of generic engines (`kind`); the catalog (catalog.ts) offers dozens of ready presets on top of them
 * (a quote's add-ons table, a payment schedule, an FAQ …), and a template is an ordered list of sections with their
 * settings. Nothing here knows about quotes: prices, VAT, texts and which columns feed what are all settings.
 *
 * Texts may hold merge fields, resolved on the server for every viewer (see merge.ts):
 *   {item.name} · {col:<column key>} · {col:<relation key>.<column key>} (the first linked item) ·
 *   {doc.date} · {doc.expires} · {account.name} · {total.one_time} · {total.recurring} · {total.grand}
 */

export const IDOC_LIMITS = {
  sections: 80,
  title: 200,
  body: 40_000,
  fields: 40,
  tableColumns: 12,
  tableRows: 200,
  cell: 2000,
  consents: 10,
  faq: 60,
  schedule: 12,
  assets: 40,
  rowsPerSection: 300,
} as const;

const key = z.string().min(1).max(64);
const title = z.string().max(IDOC_LIMITS.title);
const optTitle = title.default('');
/** A column of the item's board (or, for row sections, of the rows' board), by its stable key. */
const columnKey = z.string().min(1).max(64);
const optColumnKey = columnKey.nullable().default(null);

/** One label + value pair: the value is a text with merge fields ("{col:client}"). */
export const idocFieldSchema = z.object({ label: title, value: z.string().max(IDOC_LIMITS.cell) });
export type IdocField = z.infer<typeof idocFieldSchema>;

const base = {
  /** Stable within the document (questions and selections point at it). */
  id: key,
  /** Hidden sections stay in the template but are not shown or counted. */
  hidden: z.boolean().default(false),
  /** The catalog preset it was made from (for the builder's label), or null. */
  preset: z.string().max(64).nullable().default(null),
  /** The client may ask about this section ("question" button). */
  ask: z.boolean().default(true),
};

/** Title, subtitle, logo / cover and a grid of fields — the top of most documents. */
export const headerSectionSchema = z.object({
  ...base,
  kind: z.literal('header'),
  title: z.string().max(IDOC_LIMITS.title).default('{item.name}'),
  subtitle: z.string().max(IDOC_LIMITS.cell).default(''),
  show_logo: z.boolean().default(true),
  cover_asset_id: z.string().max(26).nullable().default(null),
  fields: z.array(idocFieldSchema).max(IDOC_LIMITS.fields).default([]),
});

/** Rich text (Markdown subset) with merge fields; plain, highlighted, collapsible or in two columns. */
export const textSectionSchema = z.object({
  ...base,
  kind: z.literal('text'),
  title: optTitle,
  body: z.string().max(IDOC_LIMITS.body).default(''),
  /** A second column (two-column layout on wide screens, one under the other on phones); empty = one column. */
  body2: z.string().max(IDOC_LIMITS.body).default(''),
  style: z.enum(['plain', 'callout', 'quote', 'muted']).default('plain'),
  collapsible: z.boolean().default(false),
  collapsed: z.boolean().default(false),
  /** Number the paragraphs of the body (contract clauses). */
  numbered: z.boolean().default(false),
});

/** Label / value pairs straight from the item's columns. */
export const fieldsSectionSchema = z.object({
  ...base,
  kind: z.literal('fields'),
  title: optTitle,
  fields: z.array(idocFieldSchema).max(IDOC_LIMITS.fields).default([]),
  layout: z.enum(['grid', 'list']).default('grid'),
});

/** People cards from a people column of the item (your contact, the team). */
export const peopleSectionSchema = z.object({
  ...base,
  kind: z.literal('people'),
  title: optTitle,
  column_key: optColumnKey,
  show_email: z.boolean().default(true),
  show_phone: z.boolean().default(true),
  note: z.string().max(IDOC_LIMITS.cell).default(''),
});

/**
 * Where the rows of a row section come from: the item's subitems, or the items linked in one of its relation
 * columns — optionally only those whose label column (status / dropdown) holds one of the given labels.
 */
export const idocRowSourceSchema = z.object({
  kind: z.enum(['subitems', 'linked']).default('subitems'),
  relation_column_key: optColumnKey,
  filter_column_key: optColumnKey,
  /** Label texts (not ids, so a template moves between boards); empty = every row. */
  filter_values: z.array(z.string().max(120)).max(50).default([]),
});
export type IdocRowSource = z.infer<typeof idocRowSourceSchema>;

/** Which column of the rows' board feeds each part of a row. Null = not used. */
export const idocLineMappingSchema = z.object({
  description: optColumnKey,
  /** One-time amount for the row (a setup fee, a fixed price). */
  price: optColumnKey,
  /** One-time amount per unit (× quantity). */
  unit_price: optColumnKey,
  /** Recurring amount for the row. */
  recurring_price: optColumnKey,
  /** Recurring amount per unit (× quantity). */
  recurring_unit_price: optColumnKey,
  /** A numbers column: the quantity (the client may change it when allowed). */
  quantity: optColumnKey,
  /** A checkbox column: the row is chosen (the client's ticks are written here). */
  selected: optColumnKey,
  /** A relation / dependency column to other rows: this row needs them chosen. */
  requires: optColumnKey,
  /** A text column: the unit's name ("pages", "users"); else the section's `unit_label`. */
  unit: optColumnKey,
});
export type IdocLineMapping = z.infer<typeof idocLineMappingSchema>;

/**
 * Rows with prices: fixed (always included), multi (tick any), single (choose one — packages / plans).
 * Every amount is a column; the totals are computed by `computeIdocTotals` on both sides.
 */
export const linesSectionSchema = z.object({
  ...base,
  kind: z.literal('lines'),
  title: optTitle,
  intro: z.string().max(IDOC_LIMITS.body).default(''),
  source: idocRowSourceSchema.default({
    kind: 'subitems',
    relation_column_key: null,
    filter_column_key: null,
    filter_values: [],
  }),
  mapping: idocLineMappingSchema.default({
    description: null,
    price: null,
    unit_price: null,
    recurring_price: null,
    recurring_unit_price: null,
    quantity: null,
    selected: null,
    requires: null,
    unit: null,
  }),
  mode: z.enum(['fixed', 'multi', 'single']).default('multi'),
  client_can_select: z.boolean().default(true),
  client_can_change_qty: z.boolean().default(false),
  /** "Select all / clear all" above the rows (the product owner) — free-choice sections the client may tick. */
  select_all: z.boolean().default(true),
  min_qty: z.number().int().min(0).max(1_000_000).default(0),
  max_qty: z.number().int().min(0).max(1_000_000).default(10_000),
  unit_label: z.string().max(60).default(''),
  show_prices: z.boolean().default(true),
  show_unselected: z.boolean().default(true),
  /** Shown as "per month" / "per year" next to recurring amounts. */
  recurring_period: z.enum(['month', 'year']).default('month'),
  /** `main` counts in the summary; `third_party` is listed apart (paid by the client to others); `none` = info. */
  totals: z.enum(['main', 'third_party', 'none']).default('main'),
});

/** A table typed in the builder (comparison, before/after, a manual schedule …). */
export const tableSectionSchema = z.object({
  ...base,
  kind: z.literal('table'),
  title: optTitle,
  intro: z.string().max(IDOC_LIMITS.body).default(''),
  columns: z.array(z.string().max(IDOC_LIMITS.title)).max(IDOC_LIMITS.tableColumns).default([]),
  rows: z
    .array(z.array(z.string().max(IDOC_LIMITS.cell)).max(IDOC_LIMITS.tableColumns))
    .max(IDOC_LIMITS.tableRows)
    .default([]),
  /** Highlight the first column (row headers). */
  header_column: z.boolean().default(false),
});

/** Totals of every `main` row section: one-time, recurring, discount, VAT, a payment schedule. */
export const summarySectionSchema = z.object({
  ...base,
  kind: z.literal('summary'),
  title: optTitle,
  discount: z
    .object({
      kind: z.enum(['percent', 'amount']),
      value: z.number().min(0).max(100_000_000),
      label: z.string().max(IDOC_LIMITS.title).default(''),
    })
    .nullable()
    .default(null),
  /** The totals block; off = only the payment schedule (a "payment terms" section next to a summary). */
  show_totals: z.boolean().default(true),
  show_vat: z.boolean().default(true),
  show_recurring: z.boolean().default(true),
  show_third_party: z.boolean().default(true),
  /** Split of the one-time total, in percent (should add up to 100; the last row takes the rounding). */
  schedule: z
    .array(z.object({ label: z.string().max(IDOC_LIMITS.title), percent: z.number().min(0).max(100) }))
    .max(IDOC_LIMITS.schedule)
    .default([]),
  /** Sticky total bar on phones. */
  sticky: z.boolean().default(true),
});

/** Image, gallery, video link or files (uploaded to the template, or the item's files column). */
export const mediaSectionSchema = z.object({
  ...base,
  kind: z.literal('media'),
  title: optTitle,
  mode: z.enum(['image', 'gallery', 'video', 'files', 'logos']).default('image'),
  asset_ids: z.array(z.string().max(26)).max(IDOC_LIMITS.assets).default([]),
  /** A files column of the item (attachments, the spec). */
  column_key: optColumnKey,
  /** A video link (YouTube / Vimeo / Loom / any https page): opened in a new tab, never embedded. */
  url: z.string().max(2000).default(''),
  caption: z.string().max(IDOC_LIMITS.cell).default(''),
});

/** One field the client fills in, written to an item column (text, email, phone, number, date, checkbox, long text). */
export const idocInputSchema = z.object({
  id: key,
  label: title,
  column_key: columnKey,
  required: z.boolean().default(false),
  help: z.string().max(IDOC_LIMITS.cell).default(''),
});
export type IdocInput = z.infer<typeof idocInputSchema>;

/** The client fills in details or ticks a checklist; every answer lands in a column of the item. */
export const inputsSectionSchema = z.object({
  ...base,
  kind: z.literal('inputs'),
  title: optTitle,
  intro: z.string().max(IDOC_LIMITS.body).default(''),
  inputs: z.array(idocInputSchema).max(IDOC_LIMITS.fields).default([]),
});

/** Questions & answers: the client's questions become updates on the item; replies there show here. */
export const questionsSectionSchema = z.object({
  ...base,
  kind: z.literal('questions'),
  title: optTitle,
  intro: z.string().max(IDOC_LIMITS.cell).default(''),
});

/** A box the client must tick before signing (a declaration, "I am authorised to sign"). */
export const idocConsentSchema = z.object({
  key,
  text: z.string().min(1).max(IDOC_LIMITS.cell),
  required: z.boolean().default(true),
});
export type IdocConsent = z.infer<typeof idocConsentSchema>;

/**
 * Approval: name (+ role), consents, optional drawn signature, then the page locks. What signing writes is all
 * settings: the signature column, a status label, the signed copy into a files column.
 */
export const signatureSectionSchema = z.object({
  ...base,
  kind: z.literal('signature'),
  title: optTitle,
  intro: z.string().max(IDOC_LIMITS.body).default(''),
  /** `sign` = name + consents (+ drawing); `approve` = one button, no signature (internal choice forms). */
  mode: z.enum(['sign', 'approve']).default('sign'),
  require_drawing: z.boolean().default(false),
  ask_role: z.boolean().default(true),
  button_label: z.string().max(80).default(''),
  consents: z.array(idocConsentSchema).max(IDOC_LIMITS.consents).default([]),
  /** A signature column of the item: the signer, time and certificate. */
  signature_column_key: optColumnKey,
  /** A status column and the label set on signing. */
  status_column_key: optColumnKey,
  status_label: z.string().max(120).default(''),
  /** A files column that receives the signed copy. */
  file_column_key: optColumnKey,
  /** Show the sender's name as already signed (counter-signature on the copy). */
  sender_signs: z.boolean().default(false),
});

/** Free-standing call to action: a highlighted line with a button (scroll to signing, or open a link). */
export const ctaSectionSchema = z.object({
  ...base,
  kind: z.literal('cta'),
  text: z.string().max(IDOC_LIMITS.cell).default(''),
  button_label: z.string().max(80).default(''),
  action: z.enum(['sign', 'questions', 'url']).default('sign'),
  url: z.string().max(2000).default(''),
});

/** Questions with answers that open (FAQ, glossary). */
export const faqSectionSchema = z.object({
  ...base,
  kind: z.literal('faq'),
  title: optTitle,
  items: z
    .array(z.object({ q: z.string().max(IDOC_LIMITS.title * 2), a: z.string().max(IDOC_LIMITS.cell * 2) }))
    .max(IDOC_LIMITS.faq)
    .default([]),
});

/** Dated rows (milestones, a schedule) from subitems / linked items: a date or timeline column. */
export const timelineSectionSchema = z.object({
  ...base,
  kind: z.literal('timeline'),
  title: optTitle,
  source: idocRowSourceSchema.default({
    kind: 'subitems',
    relation_column_key: null,
    filter_column_key: null,
    filter_values: [],
  }),
  date_column_key: optColumnKey,
  description_column_key: optColumnKey,
});

/** A line, space or a page break (printing). */
export const dividerSectionSchema = z.object({
  ...base,
  kind: z.literal('divider'),
  style: z.enum(['line', 'space', 'page_break']).default('line'),
});

/** Links to the titled sections (sticky beside the page on wide screens). */
export const tocSectionSchema = z.object({
  ...base,
  kind: z.literal('toc'),
  title: optTitle,
});

export const idocSectionSchema = z.discriminatedUnion('kind', [
  headerSectionSchema,
  textSectionSchema,
  fieldsSectionSchema,
  peopleSectionSchema,
  linesSectionSchema,
  tableSectionSchema,
  summarySectionSchema,
  mediaSectionSchema,
  inputsSectionSchema,
  questionsSectionSchema,
  signatureSectionSchema,
  ctaSectionSchema,
  faqSectionSchema,
  timelineSectionSchema,
  dividerSectionSchema,
  tocSectionSchema,
]);
export type IdocSection = z.infer<typeof idocSectionSchema>;
export type IdocSectionKind = IdocSection['kind'];
export type IdocSectionOf<K extends IdocSectionKind> = Extract<IdocSection, { kind: K }>;
export const IDOC_SECTION_KINDS = idocSectionSchema.options.map((o) => o.shape.kind.value) as IdocSectionKind[];

/** Sections that hold rows with amounts. */
export type IdocLinesSection = IdocSectionOf<'lines'>;
export type IdocSummarySection = IdocSectionOf<'summary'>;
export type IdocSignatureSection = IdocSectionOf<'signature'>;

/** Document-wide settings (a template's defaults; a shared document may override them). */
export const idocSettingsSchema = z.object({
  /** Brand colour of the page header (#RRGGBB); empty = the account's. */
  color: z.string().max(9).default(''),
  logo_asset_id: z.string().max(26).nullable().default(null),
  currency: z.string().min(3).max(3).default('ILS'),
  vat_percent: z.number().min(0).max(100).default(18),
  /** Amounts in the columns already include VAT (the summary then extracts it). */
  prices_include_vat: z.boolean().default(false),
  /** Days the link stays open after sharing; null = no expiry. */
  expires_days: z.number().int().min(1).max(3650).nullable().default(30),
  /** Before the page opens: nothing, or a one-time code mailed to the contact's address. */
  verify: z.enum(['none', 'email_code']).default('none'),
  /** Item columns: the recipient's email and name (verification, sending, the certificate). */
  contact_email_column_key: optColumnKey,
  contact_name_column_key: optColumnKey,
  /** Typed by hand instead of a column (the product owner): used when no column is set. */
  contact_email: z.string().trim().max(320).default(''),
  contact_name: z.string().trim().max(200).default(''),
  /** Who is told (bell + email) when the client opens, asks or signs: the item's people column, or the sender. */
  notify_column_key: optColumnKey,
  notify: z
    .object({ viewed: z.boolean(), question: z.boolean(), selected: z.boolean(), signed: z.boolean() })
    .default({ viewed: true, question: true, selected: false, signed: true }),
  /** After signing nothing can change; the sender may reopen (a new version). */
  lock_after_sign: z.boolean().default(true),
  /** Item number columns written with the totals (so boards, dashboards and automations see them). */
  total_one_time_column_key: optColumnKey,
  total_recurring_column_key: optColumnKey,
  /** Language and direction of the page's own words (buttons, labels). */
  language: z.enum(['he', 'en']).default('he'),
  /** Email subject and text when sending; merge fields allowed. Empty = the built-in wording. */
  email_subject: z.string().max(300).default(''),
  email_body: z.string().max(5000).default(''),
  /** This template / document's own look over the account's default (null = the account's). */
  theme: idocThemeSchema.nullable().default(null),
});
export type IdocSettings = z.infer<typeof idocSettingsSchema>;

export const idocSectionsSchema = z.array(idocSectionSchema).max(IDOC_LIMITS.sections);

/** Stored settings with every default filled in. */
export const idocSettingsOf = (raw: unknown): IdocSettings => {
  const parsed = idocSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : idocSettingsSchema.parse({});
};

/** Stored sections, each with its defaults; a section that no longer parses is dropped (never breaks a page). */
export const idocSectionsOf = (raw: unknown): IdocSection[] => {
  if (!Array.isArray(raw)) return [];
  const out: IdocSection[] = [];
  for (const s of raw.slice(0, IDOC_LIMITS.sections)) {
    const parsed = idocSectionSchema.safeParse(s);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
};

/** A fresh section of a kind with every default. */
export const newIdocSection = <K extends IdocSectionKind>(
  kind: K,
  id: string,
  patch: Record<string, unknown> = {},
): IdocSectionOf<K> => idocSectionSchema.parse({ ...patch, kind, id }) as IdocSectionOf<K>;
