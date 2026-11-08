// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { AI_IMAGE_QUALITY_RE, AI_IMAGE_SIZE_RE } from '../../ai/models';
import { filterGroupSchema } from '../../query/filter';
import { TEXT_OPS, type ColumnTypeDef } from '../types';

/**
 * AI column (the planning notes "AGENTS-MCP" מ11, D26) — 03 §3.13. A cell the model fills from other columns of the item
 * (and optionally its updates): summarise, classify into labels, extract one field, translate, or a custom prompt
 * that names columns as `{Column title}` / `{column_id}`. Everything is the column's settings, chosen in the UI:
 * the AI connection + model, the inputs, the instructions, limits, auto-run. Nothing per client in code.
 *
 * The result is an ordinary cell value (sortable, filterable, undoable through the activity log): `text` (+ a
 * number / date when the extracted field is one) and an `ai` marker — when, which model, what it cost. A person
 * may overwrite the text by hand; the marker then goes away (the cell is no longer "AI generated").
 */
export const AI_COLUMN_KINDS = ['summarize', 'classify', 'extract', 'translate', 'custom'] as const;
export type AiColumnKind = (typeof AI_COLUMN_KINDS)[number];
export const AI_EXTRACT_FIELDS = ['text', 'number', 'date', 'email', 'phone'] as const;
export type AiExtractField = (typeof AI_EXTRACT_FIELDS)[number];
export const AI_SUMMARY_LENGTHS = ['short', 'medium', 'long'] as const;
/**
 * What the column makes (AI images): text (the kinds above), or an image — the instructions (with their
 * `{Column}` values filled in) are the picture's description, the model must make images, and the image is saved
 * as a file in `image_column` (a file column of the board) while the AI cell keeps its name.
 */
export const AI_COLUMN_OUTPUTS = ['text', 'image'] as const;
export type AiColumnOutput = (typeof AI_COLUMN_OUTPUTS)[number];

/**
 * What an image cell's re-run does with the designs it made before (round 4): `version` (the default
 * for new columns) saves the new design as a new VERSION of the design made last time for the same source photo and
 * variation (files.versions — the history stays, "make current" brings an older one back); `add` saves another file.
 * A design rejected or no longer in the output column is never versioned — a new file takes its place. The value
 * `replace` of rounds 1–3 (take the old file out) is read as `version`: nothing is deleted any more.
 */
export const AI_IMAGE_RERUN_MODES = ['version', 'add'] as const;
export type AiImageRerunMode = (typeof AI_IMAGE_RERUN_MODES)[number];
/**
 * Several source photos (round 4): `each` (the default for new columns) = one separate design per photo (style
 * examples / the locked base go with each call); `together` = one call with every photo (rounds 2–3).
 */
export const AI_PHOTO_MODES = ['each', 'together'] as const;
export type AiPhotoMode = (typeof AI_PHOTO_MODES)[number];
/** Designs per call (per photo in `each`): the provider's `n` when it makes several at once, else repeated calls. */
export const AI_VARIATIONS_MAX = 4;
/** `each` designs at most this many photos of an item (the newest), so one cell never fans out without bound. */
export const AI_EACH_PHOTOS_MAX = 20;
/**
 * How much may change (round 4): `free` (as before) — the description rules; `close` — keep the composition and
 * colours of the picture it starts from; `locked` — an approved base design (the newest image of
 * `fidelity_base_column` on the item, else the newest style example) is sent first as the image to edit and the
 * item's photo as the subject: keep everything of the base, swap only the figure. Prompt guidance only — no masks
 * or inpainting. No base for `locked` → `close`, with a note on the cell.
 */
export const AI_FIDELITY_MODES = ['free', 'close', 'locked'] as const;
export type AiFidelity = (typeof AI_FIDELITY_MODES)[number];
/**
 * Photos as input, round 2: an item without a photo in the source columns is made from the
 * description only (`text`, the default — text to image, or the text prompt without pictures) or not run (`skip`).
 */
export const AI_NO_SOURCE_IMAGE_MODES = ['text', 'skip'] as const;
export type AiNoSourceImageMode = (typeof AI_NO_SOURCE_IMAGE_MODES)[number];
/** At most this many source photo columns (in order). */
export const AI_SOURCE_COLUMNS_MAX = 10;
/**
 * "Newest N" per source column goes up to this; `'all'` sends every photo — the provider's own limit (count and
 * bytes, `inputImageLimit` in server-ai) then keeps the newest, and the cell records how many went ("sent X of Y").
 */
export const AI_SOURCE_COUNT_MAX = 20;
export const aiSourceCountSchema = z.union([z.literal('all'), z.number().int().min(1).max(AI_SOURCE_COUNT_MAX)]);
export type AiSourceCount = z.infer<typeof aiSourceCountSchema>;

/**
 * Style examples (round 3): approved pictures of OTHER items of the board are the style the AI
 * continues. `column` = a file column of the board; `filter` = which items supply them (the board filter's model —
 * the same rules as views and `items/query`; null / no rules = any item with an image there); `count` = the newest N
 * images (by when they were added to the cell), never of the item being processed. They go first, before the item's
 * own photos, with a line saying they are the style to follow; read with the runner's rights (items or a column
 * they cannot read are left out). Shared by the AI column, the `generate_image` action and the MCP tool.
 */
export const AI_STYLE_COUNT_MAX = 10;
export const AI_STYLE_COUNT_DEFAULT = 3;
export const aiStyleExamplesSchema = z.object({
  column: z.string().min(1).max(64),
  filter: filterGroupSchema.nullable().default(null),
  count: z.number().int().min(1).max(AI_STYLE_COUNT_MAX).default(AI_STYLE_COUNT_DEFAULT),
});
export type AiStyleExamples = z.infer<typeof aiStyleExamplesSchema>;

/** Hard caps (code, not settings): a run never sends more than this per item, nor fills more items than this. */
export const AI_COLUMN_MAX_INPUT_CHARS = 12_000;
export const AI_COLUMN_MAX_ITEMS = 1000;

/**
 * Settings saved before round 2 name one `source_image_column`: read as `source_image_columns: [it]` (the form saves
 * the new key; the old one is dropped on the next save).
 */
const legacySourceColumn = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { source_image_column: old, ...rest } = raw as Record<string, unknown>;
  if (rest.source_image_columns === undefined && typeof old === 'string' && old)
    return { ...rest, source_image_columns: [old] };
  return rest;
};

/**
 * Round 4 on settings saved before it, so a saved column does not change by itself: `replace` →
 * `version` (the new design becomes a version of the old one instead of deleting it); settings saved with
 * `image_on_rerun` but no `photo_mode` (every column saved in rounds 1–3 — a save stores the whole parsed settings)
 * keep sending their photos `together`, in one call. New columns (no `image_on_rerun` yet) get `each`.
 */
const legacyRound4 = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (r.image_on_rerun === undefined) return r;
  return {
    ...r,
    ...(r.image_on_rerun === 'replace' ? { image_on_rerun: 'version' } : {}),
    ...(r.photo_mode === undefined ? { photo_mode: 'together' } : {}),
  };
};

const aiColumnSettingsObject = z.object({
  kind: z.enum(AI_COLUMN_KINDS).default('summarize'),
  /** The AI connection (Administration → AI ו-MCP) and model; null = the column is not set up yet. */
  connection_id: z.string().max(26).nullable().default(null),
  model: z.string().max(80).nullable().default(null),
  /** Input column ids (keys) of the same board; `{…}` references in `instructions` are added to them. */
  inputs: z.array(z.string().min(1).max(64)).max(30).default([]),
  include_name: z.boolean().default(true),
  /** The item's latest updates as input (only what the person running it may read). */
  include_updates: z.boolean().default(false),
  updates_limit: z.number().int().min(1).max(20).default(5),
  /** Custom prompt (kind custom) or extra instructions for the other kinds; `{Column}` references allowed. */
  instructions: z.string().max(4000).default(''),
  /** summarize */
  length: z.enum(AI_SUMMARY_LENGTHS).default('short'),
  /** classify: the labels of a status / dropdown column of the board, or a fixed list. */
  labels_from: z.string().max(64).nullable().default(null),
  labels: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  /** classify: also write the label into this status / dropdown column (in the same undoable batch). */
  write_to: z.string().max(64).nullable().default(null),
  /** extract */
  extract: z.enum(AI_EXTRACT_FIELDS).default('text'),
  /** translate: target language, as a person writes it ("English", "עברית"). */
  language: z.string().trim().max(40).default('English'),
  /** text (default) or image (see `AI_COLUMN_OUTPUTS`). */
  output: z.enum(AI_COLUMN_OUTPUTS).default('text'),
  /** output image: the file column (key) of the board the image is saved in. */
  image_column: z.string().max(64).nullable().default(null),
  /** output image: size / quality (null = the account's AI image defaults). */
  image_size: z.string().regex(AI_IMAGE_SIZE_RE).nullable().default(null),
  image_quality: z.string().regex(AI_IMAGE_QUALITY_RE).nullable().default(null),
  /**
   * Photos as input: file columns (keys) of the board, in order, whose images of the item go with
   * the call in that order — image output starts from them (image to image), text output reads them (a model that
   * sees images). Several columns: the prompt gets a line saying which pictures came from which column. Empty =
   * text only, as before. (Read from the old single `source_image_column` too.)
   */
  source_image_columns: z.array(z.string().min(1).max(64)).max(AI_SOURCE_COLUMNS_MAX).default([]),
  /** How many images of each source column: `'all'` (default), or the newest N. */
  source_image_count: aiSourceCountSchema.default('all'),
  /** An item without a photo there (see `AI_NO_SOURCE_IMAGE_MODES`): from the description only, or not run. */
  when_no_source_image: z.enum(AI_NO_SOURCE_IMAGE_MODES).default('text'),
  /** Style examples from other items (see `aiStyleExamplesSchema`); null = off (the default). */
  style_examples: aiStyleExamplesSchema.nullable().default(null),
  /** output image: what a re-run does with the designs this cell made before (see `AI_IMAGE_RERUN_MODES`). */
  image_on_rerun: z.enum(AI_IMAGE_RERUN_MODES).default('version'),
  /** output image, several photos: one design per photo or one from all (see `AI_PHOTO_MODES`). */
  photo_mode: z.enum(AI_PHOTO_MODES).default('each'),
  /** output image: designs per call (1–4); each is its own charged image. */
  variations: z.number().int().min(1).max(AI_VARIATIONS_MAX).default(1),
  /** output image: how much may change (see `AI_FIDELITY_MODES`). */
  fidelity: z.enum(AI_FIDELITY_MODES).default('free'),
  /** `locked`: a file column (key) of the item holding the approved base design; null = the newest style example. */
  fidelity_base_column: z.string().max(64).nullable().default(null),
  /** Run by itself when one of its inputs changes, or a person adds a file to the source column (debounced, budget-checked). */
  auto_run: z.boolean().default(false),
  /** Per-run limits: items one run fills, and dollars one run may spend. */
  max_items_per_run: z.number().int().min(1).max(AI_COLUMN_MAX_ITEMS).default(100),
  max_usd_per_run: z.number().min(0.01).max(1000).default(1),
  /** Per-column limit: dollars a month (null = only the account budget). */
  max_usd_per_month: z.number().min(0.01).max(100_000).nullable().default(null),
});
export const aiColumnSettingsSchema = z.preprocess(
  (raw) => legacyRound4(legacySourceColumn(raw)),
  aiColumnSettingsObject,
);
export type AiColumnSettings = z.infer<typeof aiColumnSettingsObject>;

const sourceImagesSchema = z.object({
  sent: z.number().int().min(0),
  total: z.number().int().min(0),
  examples: z.number().int().min(0).optional(),
});
/** At most this many designs recorded on one cell (photos × variations; `AI_EACH_PHOTOS_MAX` × `AI_VARIATIONS_MAX`). */
export const AI_OUTPUTS_MAX = AI_EACH_PHOTOS_MAX * AI_VARIATIONS_MAX;
/**
 * One design's state (the images queue): every design of a run is its own job, made one after the
 * other — `pending` (waiting its turn, or waiting to try again after a busy / slow provider: `error` says why,
 * `retry_at` when), `running`, `done`, `failed` (`error` = the reason: `rate_limited`, `timeout`, `limit_run_usd`,
 * `ai_image_content_policy` …). Absent = done (cells made before the queue).
 */
export const AI_OUTPUT_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type AiOutputStatus = (typeof AI_OUTPUT_STATUSES)[number];
export const aiOutputSchema = z.object({
  /** The file (its root); absent while a new design is not made yet (a re-made one keeps the file it versions). */
  file_id: z.string().max(26).optional(),
  name: z.string().max(255).optional(),
  source_asset_id: z.string().max(26).nullable(),
  variation: z.number().int().min(1).max(AI_VARIATIONS_MAX),
  version: z.number().int().min(1).optional(),
  rejected: z.boolean().optional(),
  source_images: sourceImagesSchema.optional(),
  status: z.enum(AI_OUTPUT_STATUSES).optional(),
  error: z.string().max(80).optional(),
  /** Provider calls tried for this design in its run (retries included). */
  attempts: z.number().int().min(0).max(100).optional(),
  retry_at: z.string().max(40).optional(),
});
export type AiOutput = z.infer<typeof aiOutputSchema>;
/** A design's state (absent = done). */
export const aiOutputStatus = (o: AiOutput): AiOutputStatus => o.status ?? 'done';
/** Designs still to make (or to try again): failed ones, and pending / running ones of a run that has stopped. */
export const aiOutputMissing = (o: AiOutput) => aiOutputStatus(o) !== 'done';

/**
 * A cell's designs (round 4): `ai.outputs`, or — on a cell made before it — its one `file_id` as the design of
 * "all photos together", variation 1. [] when the cell holds no AI image.
 */
export const aiOutputsOf = (v: AiValue | null | undefined): AiOutput[] => {
  if (!v?.ai || v.ai.output !== 'image') return [];
  if (v.ai.outputs) return v.ai.outputs;
  return v.file_id ? [{ file_id: v.file_id, name: v.text, source_asset_id: null, variation: 1 }] : [];
};

/** Who / what generated the cell (absent = written by a person). */
export const aiMarkerSchema = z.object({
  at: z.string().max(40),
  model: z.string().max(80),
  cost_usd: z.number().min(0),
  kind: z.enum(AI_COLUMN_KINDS),
  /** Absent = text. */
  output: z.enum(AI_COLUMN_OUTPUTS).optional(),
  /**
   * Photos as input: how many of the item's source photos went with the call (`sent`) of how many
   * there were (`total`) — fewer when the provider takes fewer (the newest go). Absent = no photos. Style examples
   * (round 3) count in both; `examples` = how many of the sent ones were style examples of other items.
   */
  source_images: sourceImagesSchema.optional(),
  /**
   * Image output, round 4: every design this run made — one file each in the output column (`file_id` = the file's
   * root: a re-run in `version` mode adds versions to it, `version` = which), the source photo it was made from
   * (`source_asset_id`, the photo file's id; null = all photos together / none) and its variation (1…). `rejected` =
   * a person removed it (to the trash); a later run makes a new design in its place. `source_images` = that call's
   * "sent X of Y". Absent on cells made before round 4 (their one design is `file_id`).
   */
  outputs: z.array(aiOutputSchema).max(AI_OUTPUTS_MAX).optional(),
  /** Image output: how many provider calls the run made (absent = one). */
  calls: z.number().int().min(0).optional(),
  /** Something the run could not do as set, said on the cell — `fidelity_no_base` (locked had no base: close). */
  note: z.string().max(60).optional(),
  /** Image output (the images queue): the run whose jobs make this cell's pending designs. */
  run_id: z.string().max(26).optional(),
});
export type AiMarker = z.infer<typeof aiMarkerSchema>;

export const aiValueSchema = z.object({
  text: z.string().max(20_000),
  number: z.number().finite().nullable().optional(),
  /** YYYY-MM-DD */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  ai: aiMarkerSchema.nullable().optional(),
  /** output image: the file made (saved in the column's `image_column`). */
  file_id: z.string().max(26).optional(),
});
export type AiValue = z.infer<typeof aiValueSchema>;

export const aiColumn: ColumnTypeDef<AiColumnSettings, AiValue> = {
  type: 'ai',
  labelHe: 'AI',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: aiColumnSettingsSchema,
  valueSchema: aiValueSchema,
  defaultSettings: aiColumnSettingsSchema.parse({}),
  toText: (v) => v.text,
  // Typed by a person: the text only — no "AI generated" marker.
  fromText: (text) => ({ text: text.slice(0, 20000) }) as AiValue,
  toNumber: (v) => (typeof v.number === 'number' ? v.number : null),
  toDate: (v) => v.date ?? null,
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};
