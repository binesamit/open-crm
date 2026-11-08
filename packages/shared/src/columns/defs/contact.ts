// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { TEXT_OPS, type ColumnTypeDef } from '../types';
import {
  DEFAULT_PHONE_SETTINGS,
  normalizePhone,
  PHONE_MAX_CHARS,
  phoneColumnSettingsSchema,
  phoneText,
  type PhoneColumnSettings,
} from '../phone';
import { normText, textParts } from '../text-ctx';

const peopleSettings = z.object({
  max_people: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  notify_on_assign: z.boolean().optional(),
  allow_teams: z.boolean().optional(),
  allow_guests: z.boolean().optional(),
});
const peopleValue = z.object({
  persons_and_teams: z.array(z.object({ id: z.string(), kind: z.enum(['person', 'team']) })).max(200),
});

/** 03 §2.9 — defines "assigned" for edit_assigned and view_items (05 §4, §6). */
export const peopleColumn: ColumnTypeDef<z.infer<typeof peopleSettings>, z.infer<typeof peopleValue>> = {
  type: 'people',
  labelHe: 'אנשים',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: peopleSettings,
  valueSchema: peopleValue,
  defaultSettings: { max_people: 0, notify_on_assign: true },
  toText: (v, _s, ctx) =>
    v.persons_and_teams
      .map((p) => ctx.userName?.(p.id) ?? p.id)
      .filter(Boolean)
      .join(', '),
  // Names or emails, one person or team each (the first match), no duplicates.
  fromText: (text, _s, ctx) => {
    const found = textParts(text).flatMap((p) =>
      ctx.people
        .filter((x) => normText(x.name) === normText(p) || (x.email && normText(x.email) === normText(p)))
        .slice(0, 1),
    );
    return found.length
      ? { persons_and_teams: [...new Map(found.map((x) => [x.id, { id: x.id, kind: x.kind }])).values()] }
      : undefined;
  },
  validate: (v, s) => (s.max_people && v.persons_and_teams.length > s.max_people ? 'too_many_people' : null),
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty'],
  filterModel: 'people',
  sortKey: 'text',
  aggregates: ['count'],
};

const emailValue = z.object({ email: z.email(), text: z.string().max(255).optional() });

/** 03 §2.10 */
export const emailColumn: ColumnTypeDef<Record<string, unknown>, z.infer<typeof emailValue>> = {
  type: 'email',
  labelHe: 'אימייל',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({}).loose(),
  valueSchema: emailValue,
  defaultSettings: {},
  toText: (v) => v.text || v.email,
  fromText: (text) => {
    const t = text.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? { email: t } : undefined;
  },
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

/**
 * A number's usual shape (from 2 digits: extensions, star numbers *2700, landlines, international) — what import
 * DETECTION looks for. Writing a cell is looser: any text, cleaned (`phoneText`), is kept; a number
 * that is not recognised is marked `valid: false`, never refused.
 */
export const PHONE_RE = /^(?=(?:\D*\d){2})\+?[0-9*#(][0-9 ()*#-]{1,19}$/;

const phoneValue = z.object({
  // Any wording (cleaned on write, `normalize`) — never refused for its format; only empty / too long is.
  phone: z
    .string()
    .trim()
    .max(PHONE_MAX_CHARS * 2)
    .refine((v) => phoneText(v) !== null, 'phone_no_digits'),
  country: z.string().length(2).optional(),
  /**
   * Derived on every write (`normalize`): the number in international form ("+972501234567") when it is a valid
   * number, and whether it is. Cells written before have neither until the backfill (`phoneInfoOf` computes them).
   */
  // Whatever a client sends here is dropped, never refused: `normalize` writes the real values.
  e164: z
    .string()
    .regex(/^\+[1-9]\d{5,14}$/)
    .optional()
    .catch(undefined),
  valid: z.boolean().optional().catch(undefined),
});

/**
 * 03 §2.11 — the number as typed is the display text; `e164` / `valid` are derived with libphonenumber from the
 * cell's country, else the column's `default_country`, else the account's `locale.country` (columns/phone.ts).
 */
export const phoneColumn: ColumnTypeDef<PhoneColumnSettings, z.infer<typeof phoneValue>> = {
  type: 'phone',
  labelHe: 'טלפון',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: phoneColumnSettingsSchema,
  valueSchema: phoneValue,
  defaultSettings: { ...DEFAULT_PHONE_SETTINGS, actions: [...DEFAULT_PHONE_SETTINGS.actions] },
  toText: (v) => v.phone,
  fromText: (text) => {
    const t = phoneText(text);
    return t ? { phone: t } : undefined;
  },
  normalize: (v, s, ctx) => {
    const { country } = v;
    const phone = phoneText(v.phone) ?? v.phone.trim();
    const info = normalizePhone(phone, country, s?.default_country, ctx.country);
    return {
      phone,
      ...(country ? { country } : {}),
      ...(info.e164 ? { e164: info.e164 } : {}),
      valid: info.valid,
    };
  },
  normalizeSettingsKeys: ['default_country'],
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

const linkValue = z.object({
  url: z.url({ protocol: /^https?$/ }),
  text: z.string().max(255).optional(),
});

/** 03 §2.12 — http(s) only. */
export const linkColumn: ColumnTypeDef<{ default_text?: string }, z.infer<typeof linkValue>> = {
  type: 'link',
  labelHe: 'קישור',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({ default_text: z.string().max(255).optional() }),
  valueSchema: linkValue,
  defaultSettings: {},
  toText: (v) => v.text || v.url,
  // A full URL as is; a bare domain (with an optional path) gets https://.
  fromText: (text) => {
    const t = text.trim();
    return /^https?:\/\//i.test(t)
      ? { url: t }
      : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)
        ? { url: `https://${t}` }
        : undefined;
  },
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};
