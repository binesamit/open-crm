// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { ColumnTypeDef } from '../types';

/**
 * Secret column (option 2): a password or key kept on an item, e.g. a client's site login.
 *
 * The value itself never lives in `cells`: it is encrypted on the server (a per-account data key wrapped by the
 * platform master key, AES-256-GCM) and stored in `secret_values`, written and revealed only through the secret
 * endpoints (engine 'secret' — PUT /cells refuses the column, duplicate / board copy / templates skip it). The cell
 * holds only a marker that a value exists and who changed it when, so every generic path (search, exports, AI,
 * MCP, webhooks, automation variables, activity, undo, mirror, formula) sees no secret text at all.
 *
 * It is server-side decryptable (not end-to-end): whoever runs the server and holds the master key could read it.
 * Everything below is a column setting (UI), never fixed in code.
 */
export const SECRET_REVEAL_MODES = ['board_members', 'people'] as const;
/** what the secret holds — a text (one line or `multiline`) or a check box behind the same guard. */
export const SECRET_KINDS = ['text', 'checkbox'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export type SecretRevealMode = (typeof SECRET_REVEAL_MODES)[number];

/** Limits of the settings (the UI offers values inside them). */
export const SECRET_LIMITS = {
  revealSeconds: { min: 5, max: 300, default: 30 },
  /** up to 12 hours (was 60 minutes); the account may set a lower ceiling (security settings). */
  verifyMinutes: { min: 1, max: 720, default: 15 },
  /** Reveals per person per hour before the admins are alerted; 0 = no alert. */
  alertThreshold: { min: 0, max: 1000, default: 10 },
  maxLength: 10_000,
} as const;

export const secretSettingsSchema = z
  .object({
    /** Who may reveal: everyone who can see the column (and has 2FA), or only the listed people (with 2FA). */
    reveal_mode: z.enum(SECRET_REVEAL_MODES).default('board_members'),
    reveal_user_ids: z.array(z.string().min(1).max(26)).max(500).default([]),
    /** How long a revealed value stays on screen. */
    reveal_seconds: z
      .number()
      .int()
      .min(SECRET_LIMITS.revealSeconds.min)
      .max(SECRET_LIMITS.revealSeconds.max)
      .default(SECRET_LIMITS.revealSeconds.default),
    /** How long a fresh two-factor code counts for revealing this column's values. */
    verify_minutes: z
      .number()
      .int()
      .min(SECRET_LIMITS.verifyMinutes.min)
      .max(SECRET_LIMITS.verifyMinutes.max)
      .default(SECRET_LIMITS.verifyMinutes.default),
    copy_allowed: z.boolean().default(true),
    /**
     * Replacing or clearing an existing value needs the same fresh two-factor code as a reveal (within
     * `verify_minutes`), besides edit rights. Setting a value into an empty cell does not — except in a check box,
     * where an empty cell is "not checked" and checking it is a change (`secretChangeNeedsCode`). On by default.
     */
    change_requires_code: z.boolean().default(true),
    /**
     * a long value of several lines (a key file, notes with a login) instead of one line — the
     * editor is a text area and a revealed value shows whole. Off by default (one line, as before).
     */
    multiline: z.boolean().default(false),
    /**
     * a check box (checked / not) kept like any secret — encrypted, revealed with a fresh code. The
     * kind of a column that holds values does not change (the values would not fit).
     */
    kind: z.enum(SECRET_KINDS).default('text'),
    /**
     * A check box column only: whether it is checked shows to everyone who sees the column, without a code (changing
     * it still follows `change_requires_code`). Off by default — hidden like any secret.
     */
    checkbox_visible: z.boolean().default(false),
    alert_threshold: z
      .number()
      .int()
      .min(SECRET_LIMITS.alertThreshold.min)
      .max(SECRET_LIMITS.alertThreshold.max)
      .default(SECRET_LIMITS.alertThreshold.default),
  })
  .loose();
export type SecretSettings = z.infer<typeof secretSettingsSchema>;

/** The cell's marker: a value exists, last changed when and by whom. Never the value. */
export const secretMarkerSchema = z.object({
  set: z.literal(true),
  updated_at: z.string().max(40),
  updated_by: z.string().max(26).nullable(),
  /** a check box column with `checkbox_visible` only — whether it is checked (never otherwise). */
  checked: z.boolean().optional(),
});
export type SecretMarker = z.infer<typeof secretMarkerSchema>;

/** A column's settings with every default filled in (old or partial settings included). */
export const secretSettingsOf = (settings: unknown): SecretSettings => {
  const parsed = secretSettingsSchema.safeParse(settings ?? {});
  return parsed.success ? parsed.data : secretSettingsSchema.parse({});
};

/**
 * Whether writing this cell needs a fresh code: with `change_requires_code`, replacing or clearing a value (`had`) —
 * and, (product owner: "a check box can be ticked without a code when it is empty"), any change of a check box
 * empty or not.
 */
export const secretChangeNeedsCode = (settings: SecretSettings, had: boolean) =>
  settings.change_requires_code && (had || settings.kind === 'checkbox');

/** a check box secret's stored value — '1' checked, '0' not. */
export const SECRET_CHECKED = '1';
export const SECRET_UNCHECKED = '0';
const CHECKED_WORDS = new Set(['1', 'true', 'yes', 'y', 'v', '✓', '✔', 'x', 'on', 'checked', 'כן', 'מסומן']);
const UNCHECKED_WORDS = new Set(['0', 'false', 'no', 'n', 'off', 'unchecked', 'לא', 'לא מסומן']);

/**
 * The value to store for a column: a text as is; a check box from what people type in a form, a file or the API
 * ("כן", "true", "✓" …) — anything else is not a check box value (null).
 */
export const secretValueFor = (settings: SecretSettings, raw: string): string | null => {
  if (settings.kind !== 'checkbox') return raw;
  const w = raw.trim().toLowerCase();
  return CHECKED_WORDS.has(w) ? SECRET_CHECKED : UNCHECKED_WORDS.has(w) ? SECRET_UNCHECKED : null;
};

/** The cell's marker for a stored value (whether a check box is checked only when the column shows it). */
export const secretMarkerOf = (
  settings: SecretSettings,
  value: string,
  by: string | null,
  at: Date = new Date(),
): SecretMarker => ({
  set: true,
  updated_at: at.toISOString(),
  updated_by: by,
  ...(settings.kind === 'checkbox' && settings.checkbox_visible ? { checked: value === SECRET_CHECKED } : {}),
});

export const secretColumn: ColumnTypeDef<SecretSettings, SecretMarker> = {
  type: 'secret',
  labelHe: 'סוד',
  category: 'advanced',
  priority: 'P2',
  storage: 'cell',
  engine: 'secret',
  readOnly: false, // written through the secret endpoint, never PUT /cells
  settingsSchema: secretSettingsSchema,
  valueSchema: secretMarkerSchema,
  defaultSettings: secretSettingsSchema.parse({}),
  // No text, ever: search, exports, mirrors, names, AI and automation variables read the text.
  toText: () => '',
  // "Has a value" for the empty / not-empty filter only (no number of the secret itself).
  toNumber: (v) => (v?.set ? 1 : null),
  toFormula: () => null,
  filterOperators: ['is_empty', 'is_not_empty'],
  filterModel: 'number',
  sortKey: 'none',
  aggregates: ['count'],
};
