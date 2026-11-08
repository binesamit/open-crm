// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { columnTypes } from '../columns';
import { FILE_KINDS } from '../views/settings';
import { captchaModeSchema, formAccountCaptchaSchema } from './captcha';
import { itemTemplateVarKeySchema } from './item-templates';

/**
 * Public forms (M11): a `form` view on a board whose questions are the board's columns.
 * Everything is configured in the form editor (the view); the public page `/f/<token>` shows only the configured
 * questions and labels — never column keys or other account data (a connect-boards question offers the ids and
 * names of the items it lists, nothing else of them).
 */

/** The input a question shows, by the column type it fills. Types not listed here cannot be form questions. */
export const FORM_INPUTS = {
  name: 'text',
  text: 'text',
  long_text: 'long_text',
  numbers: 'number',
  status: 'choice',
  dropdown: 'multi_choice',
  date: 'date',
  email: 'email',
  phone: 'phone',
  link: 'link',
  checkbox: 'checkbox',
  rating: 'rating',
  people: 'people',
  file: 'files',
  location: 'location',
  /**
   * a secret column — the answer is written encrypted onto the new item only (never in the submission
   * notifications or webhooks). A visible question only (no prefill: a secret never travels in a link).
   */
  secret: 'secret',
  /**
   * Connect boards — the person picks item(s) of the linked board(s). Who sees the list is the
   * question's `relation_list`; a hidden question links a fixed item / a link's item as before.
   */
  board_relation: 'relation',
} as const;
export type FormInput = (typeof FORM_INPUTS)[keyof typeof FORM_INPUTS];

/** Why a column cannot be a question (shown in the editor's "unavailable" list). */
export type FormUnsupportedReason = 'computed' | 'relation' | 'not_supported';

export const formInputOf = (type: string): FormInput | null => (FORM_INPUTS as Record<string, FormInput>)[type] ?? null;

/** null = the column can be a question; else the reason it cannot. */
export const formUnsupportedReason = (type: string): FormUnsupportedReason | null => {
  if (formInputOf(type)) return null;
  const def = columnTypes.get(type);
  if (def?.engine === 'links') return 'relation';
  if (!def || def.readOnly || def.storage !== 'cell' || def.engine) return 'computed';
  return 'not_supported';
};

/** Connect boards: a visible question lists the linked board's items; a hidden one links a fixed / link item. */
export const formIsRelation = (type: string) => type === 'board_relation';

/**
 * Who sees the item list of a visible connect-boards question —
 * - `members`: only a signed-in member of the account who may read the linked board (others never see the question);
 * - `everyone`: anyone who opens the form (only the items' names are shown; the form's creator's access decides
 *   which items).
 * A hidden question shows no list (`hidden`).
 */
export const FORM_RELATION_LISTS = ['members', 'everyone'] as const;
export type FormRelationList = (typeof FORM_RELATION_LISTS)[number];
export const relationListOf = (q: { relation_list?: FormRelationList | null }): FormRelationList =>
  q.relation_list ?? 'members';

/** columns that are never a hidden question (their value comes only from the person). */
export const formVisibleOnly = (type: string) => type === 'secret';

/** A column a form question may fill. */
export const formQuestionAllowed = (type: string) => !formUnsupportedReason(type);

/** A raw answer as the page sends it (and a hidden question's default value). */
export const formAnswerSchema = z.union([
  z.string().max(20000),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(64), z.number()])).max(100),
  z.null(),
]);
export type FormAnswer = z.infer<typeof formAnswerSchema>;

/** Show this question only when another question's answer equals `equals` (one condition per question). */
export const formConditionSchema = z.object({
  question_id: z.string().max(24),
  equals: z.union([z.string().max(500), z.number(), z.boolean()]),
});
export type FormCondition = z.infer<typeof formConditionSchema>;

export const FORM_FILE_MAX_MB = 100;
export const formFileLimitsSchema = z.object({
  /** Per file. */
  max_mb: z.number().int().min(1).max(FORM_FILE_MAX_MB).default(10),
  /** Allowed kinds (empty = any). */
  kinds: z.array(z.enum(FILE_KINDS)).max(FILE_KINDS.length).default([]),
  max_files: z.number().int().min(1).max(10).default(5),
});
export type FormFileLimits = z.infer<typeof formFileLimitsSchema>;

/**
 * Where a hidden question's value comes from (r16forms):
 * - `manual`: a fixed value typed in the editor (`default_value`);
 * - `choice`: a fixed value picked from the column's own options (labels, people, a date …) — also `default_value`;
 * - `item`: an item of a board (`hidden_item`): the item itself (connect-boards questions) or one of its column values,
 *   read when the form is submitted (with the form creator's access), so changes to that item flow into new items;
 * - `url`: a parameter of the link (`hidden_param`), so one form can be shared with different prefilled values;
 *   validated like an answer. A missing parameter falls back to `default_value` when `fallback` is on.
 */
export const FORM_HIDDEN_SOURCES = ['manual', 'choice', 'item', 'url'] as const;
export type FormHiddenSource = (typeof FORM_HIDDEN_SOURCES)[number];

export const formHiddenItemSchema = z.object({
  board_id: z.string().min(1).max(26),
  item_id: z.string().min(1).max(26),
  /** The column of that item to read (`name` = its name); null = the item itself (connect-boards questions only). */
  column_key: z.string().min(1).max(64).nullable().default(null),
});
export type FormHiddenItem = z.infer<typeof formHiddenItemSchema>;

/** A link parameter's name: letters, digits, `_` and `-`, starting with a letter. */
export const FORM_PARAM_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const formHiddenParamSchema = z.object({
  name: z.string().regex(FORM_PARAM_RE),
  /** No parameter in the link → the fixed value (`default_value`); off = left empty. */
  fallback: z.boolean().default(true),
});
export type FormHiddenParam = z.infer<typeof formHiddenParamSchema>;

/** The link that prefills one hidden question from a parameter (`?ref=…`). */
export const formParamUrl = (url: string, param: string, value: string) =>
  `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(param)}=${encodeURIComponent(value)}`;

export const FORM_QUESTION_ID_RE = /^[a-z0-9]{4,24}$/;
export const MAX_FORM_QUESTIONS = 100;

export const formQuestionSchema = z.object({
  id: z.string().regex(FORM_QUESTION_ID_RE),
  column_key: z.string().min(1).max(64),
  /** Overrides the column's title on the form (empty = the title). */
  label: z.string().trim().max(200).default(''),
  help: z.string().max(1000).default(''),
  required: z.boolean().default(false),
  /** Not shown; the item gets `default_value` (prefill). */
  hidden: z.boolean().default(false),
  default_value: formAnswerSchema.optional(),
  /** Hidden questions: where the value comes from (absent = `manual`). */
  hidden_source: z.enum(FORM_HIDDEN_SOURCES).optional(),
  /** `hidden_source: 'item'`. */
  hidden_item: formHiddenItemSchema.nullable().optional(),
  /** `hidden_source: 'url'`. */
  hidden_param: formHiddenParamSchema.nullable().optional(),
  condition: formConditionSchema.nullable().default(null),
  /** File questions only. */
  files: formFileLimitsSchema.optional(),
  /** Visible connect-boards questions: who sees the item list (absent = `members`). */
  relation_list: z.enum(FORM_RELATION_LISTS).optional(),
});
export type FormQuestion = z.infer<typeof formQuestionSchema>;

export const FORM_ACCESS = ['public', 'members'] as const;
export type FormAccess = (typeof FORM_ACCESS)[number];

export const formItemTemplateSchema = z.object({
  template_id: z.string().min(1).max(26),
  variables: z.record(itemTemplateVarKeySchema, z.string().regex(FORM_QUESTION_ID_RE)).default({}),
});
export type FormItemTemplate = z.infer<typeof formItemTemplateSchema>;

export const formSettingsSchema = z.object({
  /** The public page's language: its texts and direction (he = RTL). */
  language: z.enum(['he', 'en']).default('he'),
  /** Empty = the default ("שליחה"). */
  submit_label: z.string().trim().max(60).default(''),
  /** Shown after submitting (empty = the default thank-you); ignored when `redirect_url` is set. */
  success_message: z.string().max(2000).default(''),
  /**
   * The privacy notice shown above the submit button (privacy — Israel Privacy Law §11, GDPR art. 13)
   * who collects the answers and why, whether answering is required, who receives them, and the right to see and
   * correct them. Empty = none (the account collecting the data is responsible for it).
   */
  privacy_notice: z.string().max(2000).default(''),
  redirect_url: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).default(''),
  /** Uploaded through the files module (the account's assets). */
  logo_asset_id: z.string().max(26).nullable().default(null),
  cover_asset_id: z.string().max(26).nullable().default(null),
  /** Show the account's name and logo on the page. */
  show_account_branding: z.boolean().default(true),
  /** After this moment the form answers "closed". */
  close_at: z.iso.datetime({ offset: true }).nullable().default(null),
  max_submissions: z.number().int().min(1).max(1_000_000).nullable().default(null),
  /** Other sites may embed the page in an iframe (frame-ancestors for /f/* only). Off by default. */
  allow_embed: z.boolean().default(false),
  /**
   * Cloudflare Turnstile on this form: `inherit` = the account's "public forms" setting
   * (Administration → Security), `on` / `off` = this form only. A form saved before this had no mode: with its own
   * keys it reads as `on`, else `inherit` — the server always answers with the mode in effect. No default here on
   * purpose: a partial save that does not send it leaves it as it was.
   */
  captcha_mode: captchaModeSchema.optional(),
  /**
   * Optional own keys of this form (they win over the account's): the site key here, the secret write-only
   * (`turnstile_secret` in the update).
   */
  turnstile_site_key: z.string().trim().max(100).default(''),
  /**
   * Item templates (phase 2): each submission makes its item from this template of the form's board
   * its subitems, values, updates and files — then the answers fill the item as always (they win over the template's
   * values). `variables` = `{template variable: question id}`: the answer of that question (a date question → a
   * date variable, a people question → a person one, any answer's text → a text one); unanswered = the variable's
   * default. null = a plain item.
   */
  item_template: formItemTemplateSchema.nullable().default(null),
});
export type FormSettings = z.infer<typeof formSettingsSchema>;

/** A partial update: only the fields sent. `.partial()` alone would still fill every unsent field with its
 *  default (zod 4) and so reset it on the server, which merges this over the stored settings. */
const formSettingsPatchSchema = z.object(
  Object.fromEntries(Object.entries(formSettingsSchema.shape).map(([key, field]) => [key, field.unwrap().optional()])),
) as unknown as z.ZodType<Partial<FormSettings>>;

/** The form as its editor sees it (GET /views/:id/form). */
export const formSchema = z.object({
  id: z.string(),
  view_id: z.string(),
  board_id: z.string(),
  title: z.string(),
  description: z.string(),
  /** Off = the public link answers "not found". */
  enabled: z.boolean(),
  access: z.enum(FORM_ACCESS),
  /** The unguessable part of `/f/<token>`. */
  token: z.string(),
  /** null = the board's first group. */
  target_group_id: z.string().nullable(),
  questions: z.array(formQuestionSchema),
  settings: formSettingsSchema,
  /** A Turnstile secret is saved (it is never sent back). */
  turnstile_secret_set: z.boolean(),
  /** The account's Turnstile, for the mode picker (what `inherit` means, whether `on` can be picked). */
  account_captcha: formAccountCaptchaSchema,
  submissions_count: z.number().int(),
  revision: z.number().int(),
  can_manage: z.boolean(),
});
export type Form = z.infer<typeof formSchema>;

export const updateFormSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  enabled: z.boolean().optional(),
  access: z.enum(FORM_ACCESS).optional(),
  target_group_id: z.string().max(26).nullable().optional(),
  questions: z.array(formQuestionSchema).max(MAX_FORM_QUESTIONS).optional(),
  settings: formSettingsPatchSchema.optional(),
  /** Write-only: a new secret, or null to remove it. */
  turnstile_secret: z.string().trim().min(1).max(200).nullable().optional(),
  /** The revision being saved over (409 on a newer save). */
  revision: z.number().int().optional(),
});
export type UpdateFormInput = z.infer<typeof updateFormSchema>;

/** One choice of a status / dropdown / people question. */
export const publicChoiceSchema = z.object({
  value: z.union([z.number(), z.string()]),
  label: z.string(),
  color: z.string().optional(),
});

export const publicQuestionSchema = z.object({
  id: z.string(),
  input: z.enum(Object.values(FORM_INPUTS) as [FormInput, ...FormInput[]]),
  label: z.string(),
  help: z.string(),
  required: z.boolean(),
  condition: formConditionSchema.nullable(),
  choices: z.array(publicChoiceSchema).optional(),
  /** multi_choice / people: several answers allowed. */
  multiple: z.boolean().optional(),
  rating_max: z.number().int().optional(),
  files: formFileLimitsSchema.optional(),
  /** a secret question — one line, several lines or a check box (the column's kind). */
  secret: z.enum(['text', 'multiline', 'checkbox']).optional(),
  /**
   * A connect-boards question — its items come page by page from
   * `GET /public/forms/:token/questions/:id/options` (`board` = an index into `boards`). `boards`: the linked boards'
   * names, only when there are several.
   */
  relation: z.object({ boards: z.array(z.string()) }).optional(),
});
export type PublicQuestion = z.infer<typeof publicQuestionSchema>;

/** GET /public/forms/:token — only what the page shows. */
export const publicFormSchema = z.object({
  title: z.string(),
  description: z.string(),
  language: z.enum(['he', 'en']),
  access: z.enum(FORM_ACCESS),
  logo_url: z.string().nullable(),
  cover_url: z.string().nullable(),
  account: z.object({ name: z.string(), logo_url: z.string().nullable() }).nullable(),
  questions: z.array(publicQuestionSchema),
  submit_label: z.string(),
  /** The form's privacy notice (empty = none). */
  privacy_notice: z.string(),
  /** Set when the form asks for a Turnstile check. */
  turnstile_site_key: z.string().nullable(),
});
export type PublicForm = z.infer<typeof publicFormSchema>;

/** The honeypot field's name: a hidden input people never fill and naive bots do. */
export const FORM_HONEYPOT = 'website';

export const MAX_FORM_PARAMS = 30;

export const publicSubmitSchema = z.object({
  answers: z.record(z.string().max(24), formAnswerSchema),
  [FORM_HONEYPOT]: z.string().max(500).optional(),
  turnstile_token: z.string().max(4096).optional(),
  /** The page link's query parameters (hidden questions may take their value from one). */
  params: z
    .record(z.string().max(40), z.string().max(2000))
    .refine((r) => Object.keys(r).length <= MAX_FORM_PARAMS, { message: 'too_many_params' })
    .optional(),
});
export type PublicSubmitInput = z.infer<typeof publicSubmitSchema>;

export const publicSubmitResultSchema = z.object({
  ok: z.literal(true),
  /** The thank-you text (empty = the page's default). */
  message: z.string(),
  redirect_url: z.string().nullable(),
});

/** One page of a connect-boards question's items (only id and name). */
export const publicRelationOptionsQuerySchema = z.object({
  q: z.string().max(100).default(''),
  board: z.coerce.number().int().min(0).max(20).default(0),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const publicRelationOptionsSchema = z.object({
  data: z.array(z.object({ value: z.string(), label: z.string() })),
  next_offset: z.number().int().nullable(),
});
export type PublicRelationOptions = z.infer<typeof publicRelationOptionsSchema>;

export const publicUploadSchema = z.object({
  question_id: z.string().max(24),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(1),
  mime: z.string().max(255).default('application/octet-stream'),
});
export const publicUploadResultSchema = z.object({
  upload_id: z.string(),
  upload_url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
});

/** Does an answer satisfy a condition? Choices compare by value, text case-insensitively, a checkbox by on/off. */
export const conditionMet = (cond: FormCondition, answer: FormAnswer | undefined): boolean => {
  if (typeof cond.equals === 'boolean') return (answer === true) === cond.equals;
  if (answer === null || answer === undefined) return false;
  const want = String(cond.equals).trim().toLocaleLowerCase();
  if (Array.isArray(answer)) return answer.some((a) => String(a).trim().toLocaleLowerCase() === want);
  return String(answer).trim().toLocaleLowerCase() === want;
};

/**
 * The questions that apply to these answers, in order: a question with a condition applies only when the question
 * it depends on applies and its answer meets the condition. Hidden questions always apply (with their default).
 */
export const applicableQuestions = <Q extends { id: string; condition: FormCondition | null }>(
  questions: Q[],
  answers: Record<string, FormAnswer | undefined>,
): Q[] => {
  const applies = new Set<string>();
  const out: Q[] = [];
  for (const q of questions) {
    const c = q.condition;
    if (c && (!applies.has(c.question_id) || !conditionMet(c, answers[c.question_id]))) continue;
    applies.add(q.id);
    out.push(q);
  }
  return out;
};

/** An answer counts as given (for "required"). */
export const answered = (a: FormAnswer | undefined): boolean =>
  a !== undefined &&
  a !== null &&
  a !== false &&
  !(typeof a === 'string' && !a.trim()) &&
  !(Array.isArray(a) && a.length === 0);

/** A new question id (random, not derived from anything internal). */
export const newQuestionId = (rand: () => number = Math.random) => {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[Math.floor(rand() * abc.length)];
  return s;
};
