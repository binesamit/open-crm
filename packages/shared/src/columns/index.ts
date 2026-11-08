// SPDX-License-Identifier: AGPL-3.0-only
import type { AnyColumnTypeDef, ColumnCtx, NewColumnDefaults } from './types';
import {
  checkboxColumn,
  docColumn,
  longTextColumn,
  nameColumn,
  numbersColumn,
  ratingColumn,
  textColumn,
  voteColumn,
} from './defs/basic';
import { dropdownColumn, statusColumn, tagsColumn } from './defs/labels';
import { dateColumn, timelineColumn } from './defs/dates';
import { emailColumn, linkColumn, peopleColumn, phoneColumn } from './defs/contact';
import { timeTrackingColumn } from './defs/time';
import {
  buttonColumn,
  colorPickerColumn,
  countryColumn,
  hourColumn,
  locationColumn,
  progressColumn,
  weekColumn,
  worldClockColumn,
} from './defs/p1';
import {
  boardRelationColumn,
  creationLogColumn,
  dependencyColumn,
  fileColumn,
  formulaColumn,
  itemIdColumn,
  lastUpdatedColumn,
  mirrorColumn,
} from './defs/computed';
import { aiColumn } from './defs/ai';
import { secretColumn } from './defs/secret';
import { signatureColumn } from './defs/signature';

export * from './types';
export * from './from-text';
export * from './convert';
export * from './phone';
export * from './name-source';
export * from './timeline-overdue';
export * from './file-links';
export {
  formatDuration,
  MAX_ENTRY_SECONDS,
  parseDuration,
  timeSettingsSchema,
  timeValueSchema,
  validateEntryRange,
  type TimeSettings,
  type TimeValue,
} from './defs/time';
export { DEFAULT_DATE_TIME } from './defs/dates';
export { nextLabelId, reconcileLabels, statusLabelSchema, withLabelColorKeys, type StatusLabel } from './defs/labels';
export {
  formatFormulaNumber,
  formulaHref,
  ITEM_KEY_PREFIX_RE,
  labelColor,
  lastUpdatedValue,
  META_LOG_MODES,
  metaLogText,
  type LastUpdatedSettings,
  type MetaLogMode,
  MIRROR_DISPLAYS,
  MIRROR_SUBITEMS,
  mirrorLabelSchema,
  type MirrorDisplay,
  type MirrorEach,
  type MirrorLabel,
  mirrorSourceOf,
  mirrorSourceSchema,
  type MirrorSource,
  RELATION_PICKER_GROUPINGS,
  type RelationPickerGrouping,
} from './defs/computed';
export { formatNumberAs, numberFormatSettings, type NumberFormat } from './defs/basic';
export {
  BUTTON_ACTIONS,
  buttonActionSchema,
  buttonSettingsSchema,
  colorFromText,
  computeProgress,
  formatHourValue,
  hourFromText,
  isoWeekNumber,
  isWorkingTime,
  locationFromText,
  locationValueSchema,
  pendingGeocode,
  progressConfigured,
  progressSettingsSchema,
  PROGRESS_SOURCES,
  subitemsProgress,
  timeZoneFromText,
  timeZones,
  weekOf,
  zoneCity,
  zoneNow,
  type ButtonAction,
  type CreateLinkedAction,
  createLinkedSchema,
  type ButtonSettings,
  type HourValue,
  type LocationValue,
  type ProgressNode,
  type ProgressSettings,
  type ProgressSettingsInput,
  type ProgressSource,
  type WeekValue,
  type WorldClockSettings,
} from './defs/p1';
export {
  AI_COLUMN_KINDS,
  AI_COLUMN_OUTPUTS,
  AI_COLUMN_MAX_INPUT_CHARS,
  AI_COLUMN_MAX_ITEMS,
  AI_EXTRACT_FIELDS,
  AI_EACH_PHOTOS_MAX,
  AI_FIDELITY_MODES,
  AI_IMAGE_RERUN_MODES,
  AI_NO_SOURCE_IMAGE_MODES,
  AI_OUTPUTS_MAX,
  AI_PHOTO_MODES,
  AI_SOURCE_COLUMNS_MAX,
  AI_SOURCE_COUNT_MAX,
  AI_STYLE_COUNT_DEFAULT,
  AI_STYLE_COUNT_MAX,
  AI_SUMMARY_LENGTHS,
  AI_VARIATIONS_MAX,
  aiColumnSettingsSchema,
  aiMarkerSchema,
  AI_OUTPUT_STATUSES,
  aiOutputMissing,
  aiOutputSchema,
  aiOutputStatus,
  aiOutputsOf,
  aiSourceCountSchema,
  aiStyleExamplesSchema,
  aiValueSchema,
  type AiColumnKind,
  type AiColumnOutput,
  type AiColumnSettings,
  type AiExtractField,
  type AiFidelity,
  type AiImageRerunMode,
  type AiOutput,
  type AiOutputStatus,
  type AiPhotoMode,
  type AiNoSourceImageMode,
  type AiSourceCount,
  type AiStyleExamples,
  type AiMarker,
  type AiValue,
} from './defs/ai';
export {
  SECRET_CHECKED,
  SECRET_KINDS,
  SECRET_LIMITS,
  SECRET_REVEAL_MODES,
  SECRET_UNCHECKED,
  secretMarkerOf,
  secretMarkerSchema,
  secretChangeNeedsCode,
  secretSettingsOf,
  secretSettingsSchema,
  secretValueFor,
  type SecretKind,
  type SecretMarker,
  type SecretRevealMode,
  type SecretSettings,
} from './defs/secret';
export {
  signatureColumn,
  signatureSettingsSchema,
  signatureValueSchema,
  type SignatureSettings,
  type SignatureValue,
} from './defs/signature';
export { COUNTRY_CODES, countryName, flagEmoji, isCountryCode, parseCountry } from './countries';

/** The column-type registry (D4). API, worker and web all read types from here — never `switch (type)`. */
const DEFS: AnyColumnTypeDef[] = [
  nameColumn,
  textColumn,
  longTextColumn,
  numbersColumn,
  statusColumn,
  dropdownColumn,
  dateColumn,
  timelineColumn,
  peopleColumn,
  emailColumn,
  phoneColumn,
  linkColumn,
  checkboxColumn,
  ratingColumn,
  fileColumn,
  boardRelationColumn,
  dependencyColumn,
  mirrorColumn,
  formulaColumn,
  itemIdColumn,
  creationLogColumn,
  lastUpdatedColumn,
  timeTrackingColumn,
  tagsColumn,
  voteColumn,
  docColumn,
  progressColumn,
  buttonColumn,
  hourColumn,
  weekColumn,
  worldClockColumn,
  colorPickerColumn,
  countryColumn,
  locationColumn,
  aiColumn,
  secretColumn,
  signatureColumn,
];

const registry = new Map(DEFS.map((d) => [d.type, d]));

export const columnTypes = {
  get: (type: string): AnyColumnTypeDef | undefined => registry.get(type),
  has: (type: string) => registry.has(type),
  all: (): AnyColumnTypeDef[] => DEFS,
  /** Types a user can add from the column center (not `name`, which every board has exactly once). */
  creatable: (): AnyColumnTypeDef[] => DEFS.filter((d) => d.type !== 'name'),
};

/**
 * Types whose cell is a cache written by their own endpoints (files, time entries, votes, cell docs, secrets,
 * signatures) — never
 * by PUT /cells, never copied by duplicate / board copy.
 */
export const ownWriter = (def: AnyColumnTypeDef | undefined) =>
  def?.engine === 'files' ||
  def?.engine === 'time' ||
  def?.engine === 'vote' ||
  def?.engine === 'doc' ||
  def?.engine === 'button' ||
  def?.engine === 'secret' ||
  def?.engine === 'signature';

export type DerivedValues = {
  textValue: string | null;
  numberValue: number | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
};

const asDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso) : null;

/**
 * Validates a cell value against its type + settings and derives text/number/date (02 §8, 03 §1).
 * Returns the parsed value (coerced, e.g. numeric strings) or an error code.
 */
export const parseCellValue = (
  def: AnyColumnTypeDef,
  settings: unknown,
  raw: unknown,
  ctx: ColumnCtx = {},
): { ok: true; value: unknown; derived: DerivedValues } | { ok: false; error: string; issues?: unknown } => {
  const parsedSettings = def.settingsSchema.safeParse(settings ?? def.defaultSettings);
  const s = parsedSettings.success ? parsedSettings.data : def.defaultSettings;
  const parsed = def.valueSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid_value', issues: parsed.error.issues };
  const problem = def.validate?.(parsed.data, s);
  if (problem) return { ok: false, error: problem };
  const value = def.normalize ? def.normalize(parsed.data, s, ctx) : parsed.data;
  return { ok: true, value, derived: deriveValues(def, s, value, ctx) };
};

/**
 * The denormalized text/number/date keys of a stored value under (possibly new) settings — no validation,
 * so a cell on a deactivated label still derives. Used on write and when label settings change.
 */
export const deriveValues = (
  def: AnyColumnTypeDef,
  settings: unknown,
  value: unknown,
  ctx: ColumnCtx = {},
): DerivedValues => ({
  textValue: def.toText(value, settings, ctx) || null,
  numberValue: def.toNumber?.(value, settings) ?? null,
  dateValue: asDate(def.toDate?.(value, settings)),
  dateEndValue: asDate(def.toDateEnd?.(value, settings)),
});

/**
 * The settings a NEW column is made with: `settings` (the type's defaults when absent) with the
 * keys the account's defaults for new columns give (`newColumnSettings`) wherever `settings` leaves them out.
 * Only for columns made from scratch (add column, the AI / MCP tool, a file import's new columns, a built-in
 * template) — a copy of an existing column keeps its settings as they are.
 */
export const withNewColumnDefaults = (
  def: AnyColumnTypeDef,
  settings: Record<string, unknown> | undefined,
  defaults: NewColumnDefaults | undefined,
): Record<string, unknown> => {
  const base = (settings ?? def.defaultSettings ?? {}) as Record<string, unknown>;
  const fromAccount = (def.newColumnSettings?.(defaults ?? {}) ?? {}) as Record<string, unknown>;
  return { ...fromAccount, ...base };
};

/** Column ids (keys): `[a-z][a-z0-9_]{0,19}` for new columns; template and imported ids are kept verbatim (≤50). */
export const COLUMN_KEY_RE = /^[a-z][a-z0-9_]{0,19}$/;
export const IMPORTED_COLUMN_KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;
