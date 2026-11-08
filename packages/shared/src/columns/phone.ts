// SPDX-License-Identifier: AGPL-3.0-only
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import { isCountryCode } from './countries';

/**
 * Phone numbers: every phone cell also keeps its international form (E.164, "+972501234567")
 * computed with libphonenumber from the number as typed and a country — the cell's own, else the column's
 * `default_country`, else the account's `locale.country`. What the user typed (`phone`) is never changed and stays
 * the display text. A number that cannot be read (an extension such as *2700, a missing digit) gets `valid: false`
 * and no `e164`: it is shown as typed and offers only "call" and "copy".
 */

/**
 * Keys of stored cell values that are derived (`ColumnTypeDef.normalize`), not typed: comparisons of "did someone
 * change this cell" (undo) ignore them, so a backfill or a new default country never reads as an edit.
 */
export const DERIVED_VALUE_KEYS: readonly string[] = ['e164', 'valid'];

/** What a click on a phone number can do (the column chooses a subset; 03 §2.11). */
export const PHONE_ACTIONS = ['whatsapp', 'telegram', 'call', 'sms', 'copy'] as const;
export type PhoneAction = (typeof PHONE_ACTIONS)[number];
export const phoneActionSchema = z.enum(PHONE_ACTIONS);

/** Actions that need a number in international form (a messaging app finds the person by it). */
const NEEDS_VALID: ReadonlySet<PhoneAction> = new Set(['whatsapp', 'telegram', 'sms']);

const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((c) => isCountryCode(c), 'invalid_country');

/**
 * Settings of a phone column. Every key is optional so columns saved before keep working; `phoneColumnConfig`
 * reads them with their defaults. PUT/PATCH of column settings replaces the whole object — send every key.
 */
export const phoneColumnSettingsSchema = z
  .object({
    /** ISO country of numbers typed without a country code (e.g. 050…). */
    default_country: countrySchema.optional(),
    /** The on/off switch of the whole click menu (off = the number is plain text). Default on. */
    click_actions_enabled: z.boolean().optional(),
    /** Which actions the menu offers, in this order. Default: all of PHONE_ACTIONS. */
    actions: z.array(phoneActionSchema).min(1).max(PHONE_ACTIONS.length).optional(),
    /** What a long press / Ctrl+click (or a user whose preference is "the column's default") does at once. */
    default_action: phoneActionSchema.optional(),
    /** A text column of the same board with the person's Telegram username (t.me/<username> always works). */
    telegram_username_column: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,19}$/)
      .nullable()
      .optional(),
  })
  .refine((s) => !s.actions || new Set(s.actions).size === s.actions.length, {
    message: 'duplicate_action',
    path: ['actions'],
  })
  .refine((s) => !s.default_action || !s.actions || s.actions.includes(s.default_action), {
    message: 'default_action_not_allowed',
    path: ['default_action'],
  });
export type PhoneColumnSettings = z.infer<typeof phoneColumnSettingsSchema>;

/** What a new phone column starts with. */
export const DEFAULT_PHONE_SETTINGS = {
  default_country: 'IL',
  click_actions_enabled: true,
  actions: [...PHONE_ACTIONS],
  default_action: 'whatsapp',
} satisfies PhoneColumnSettings;

export type PhoneColumnConfig = {
  enabled: boolean;
  actions: PhoneAction[];
  defaultAction: PhoneAction;
  defaultCountry: string | null;
  telegramUsernameColumn: string | null;
};

/** The settings of a phone column with every default filled in (unknown / legacy settings never throw). */
export const phoneColumnConfig = (settings: unknown): PhoneColumnConfig => {
  const s = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const actions = Array.isArray(s.actions)
    ? PHONE_ACTIONS.filter((a) => (s.actions as unknown[]).includes(a)).sort(
        (a, b) => (s.actions as unknown[]).indexOf(a) - (s.actions as unknown[]).indexOf(b),
      )
    : [...PHONE_ACTIONS];
  const list = actions.length ? actions : [...PHONE_ACTIONS];
  const def = PHONE_ACTIONS.find((a) => a === s.default_action);
  return {
    enabled: s.click_actions_enabled !== false,
    actions: list,
    defaultAction: def && list.includes(def) ? def : list[0]!,
    defaultCountry: isCountryCode(s.default_country) ? (s.default_country as string) : null,
    telegramUsernameColumn: typeof s.telegram_username_column === 'string' ? s.telegram_username_column : null,
  };
};

export type PhoneInfo = {
  /** "+972501234567" when the number is a valid number; null otherwise. */
  e164: string | null;
  valid: boolean;
  /** The country the number belongs to (from its code or the default used), when known. */
  country: string | null;
};

const supported = (c: string | null | undefined): CountryCode | undefined =>
  c && isCountryCode(c.toUpperCase()) && isSupportedCountry(c.toUpperCase())
    ? (c.toUpperCase() as CountryCode)
    : undefined;

/** The longest phone text kept (after cleaning). */
export const PHONE_MAX_CHARS = 80;

const DIGIT_BLOCKS = [0x0660, 0x06f0, 0xff10, 0x0966]; // Arabic-Indic, Persian, full-width, Devanagari zeros

/** A character class from code points / ranges (kept as numbers: the invisible characters stay readable here). */
const charClass = (parts: (number | [number, number])[]) =>
  new RegExp(
    `[${parts.map((p) => (Array.isArray(p) ? `${String.fromCharCode(p[0])}-${String.fromCharCode(p[1])}` : String.fromCharCode(p))).join('')}]`,
    'g',
  );
/** Soft hyphen, Arabic letter mark, zero-width and direction marks / isolates (LRI…PDI), BOM. */
const INVISIBLE = charClass([0xad, 0x61c, 0x180e, [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], 0xfeff]);
const OTHER_DIGITS = charClass([
  [0x660, 0x669],
  [0x6f0, 0x6f9],
  [0xff10, 0xff19],
  [0x966, 0x96f],
]);
/** Hyphens, dashes, minus signs. */
const DASHES = charClass([[0x2010, 0x2015], 0x2212, 0xfe58, 0xfe63, 0xff0d]);

/**
 * A phone number as people paste it (product owner: "too many errors — with or without the country code, the
 * 0, dashes, spaces; e.g. "+972 54-123-4567" between direction isolates): direction marks and other invisible characters (copy-paste from
 * WhatsApp / contacts) go, any dash becomes "-", any space one " ", non-Latin digits Latin ones, a "tel:" prefix
 * goes; the rest is kept as written (what the cell shows).
 */
export const cleanPhoneInput = (raw: string): string => {
  let s = raw.normalize('NFKC');
  s = s.replace(INVISIBLE, '');
  s = s.replace(OTHER_DIGITS, (d) => {
    const c = d.charCodeAt(0);
    const zero = DIGIT_BLOCKS.find((z) => c >= z && c <= z + 9)!;
    return String(c - zero);
  });
  s = s.replace(DASHES, '-');
  // JavaScript's \s already covers the no-break, thin and other Unicode spaces.
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^\s*(?:tel|callto):\s*/i, '');
  return s.trim();
};

/**
 * The text a phone cell keeps — cleaned, any wording (never refused for its format: an extension, a note); null
 * when it has no digit at all (a name is not a phone — also what converting a text column relies on) or is too long.
 */
export const phoneText = (raw: string): string | null => {
  const s = cleanPhoneInput(raw);
  return s && /\d/.test(s) && s.length <= PHONE_MAX_CHARS ? s : null;
};

/**
 * E.164 of a number as typed. `countries`: the defaults to try in order (cell's, column's, account's) — the first
 * known one is used for a number without a country code; a number with "+" / "00" / its code needs none.
 * Star / hash numbers (*2700, #31#) are never valid.
 */
export const normalizePhone = (phone: string, ...countries: (string | null | undefined)[]): PhoneInfo => {
  const raw = cleanPhoneInput(phone);
  if (!raw || /[*#]/.test(raw)) return { e164: null, valid: false, country: null };
  const country = countries.map(supported).find(Boolean);
  // "00972…" is the international prefix in most countries (libphonenumber only knows it with a country).
  const text = raw.replace(/^\s*00(?=[1-9])/, '+');
  try {
    const parsed = parsePhoneNumberFromString(text, country);
    if (parsed?.isValid()) return { e164: parsed.number, valid: true, country: parsed.country ?? country ?? null };
  } catch {
    // libphonenumber throws on some garbage; it is just not a number then.
  }
  return { e164: null, valid: false, country: country ?? null };
};

type PhoneCellValue = { phone?: unknown; country?: unknown; e164?: unknown; valid?: unknown };

/**
 * E.164 and validity of a stored phone cell: what the cell keeps (written since this change / backfilled), else
 * computed now with the column's and the account's country (legacy cells).
 */
export const phoneInfoOf = (
  value: unknown,
  columnCountry?: string | null,
  accountCountry?: string | null,
): PhoneInfo => {
  const v = (value && typeof value === 'object' ? value : {}) as PhoneCellValue;
  if (typeof v.valid === 'boolean')
    return {
      e164: v.valid && typeof v.e164 === 'string' ? v.e164 : null,
      valid: v.valid && typeof v.e164 === 'string',
      country: typeof v.country === 'string' ? v.country : null,
    };
  if (typeof v.phone !== 'string') return { e164: null, valid: false, country: null };
  return normalizePhone(v.phone, typeof v.country === 'string' ? v.country : null, columnCountry, accountCountry);
};

/** The digits of an E.164 number, without "+". */
export const e164Digits = (e164: string) => e164.replace(/\D/g, '');

export type WhatsappMode = 'auto' | 'app' | 'web';
export type PhonePlatform = 'ios' | 'android' | 'other';

export type PhoneLinkOptions = {
  /** WhatsApp: `auto` = wa.me (the phone's app, or the desktop app / WhatsApp Web), `app` = whatsapp://, `web`. */
  whatsapp?: WhatsappMode;
  /** A message to prefill (WhatsApp, SMS from the device). */
  text?: string;
  /** SMS body syntax differs: iOS `&body=`, others `?body=`. */
  platform?: PhonePlatform;
  /** The person's Telegram username (the column chosen in `telegram_username_column`): t.me/<username>. */
  telegramUsername?: string | null;
};

const TELEGRAM_USER_RE = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/;

/** A Telegram username as typed ("@name", "t.me/name", "https://t.me/name") → "name"; null if not one. */
export const telegramUsername = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(?:t|telegram)\.me\//i, '');
  return TELEGRAM_USER_RE.exec(s)?.[1] ?? null;
};

/**
 * The link of one action, or null when the action has no link (copy) or cannot work for this number (whatsapp /
 * telegram / sms need a valid number; telegram also works with a username).
 * - whatsapp: https://wa.me/<digits> (auto) · whatsapp://send?phone=<digits> (app) · https://web.whatsapp.com/send?phone=<digits> (web)
 * - telegram: https://t.me/<username> · https://t.me/+<digits> (works only when the person allows lookup by phone)
 * - call: tel:<e164> · tel:<as typed> for numbers that are not valid (extensions, *2700)
 * - sms: sms:<e164> with ?body= (Android/other) or &body= (iOS)
 */
export const phoneActionLink = (
  action: PhoneAction,
  phone: { phone: string; e164: string | null },
  opts: PhoneLinkOptions = {},
): string | null => {
  const e164 = phone.e164;
  const digits = e164 ? e164Digits(e164) : null;
  const text = opts.text?.trim() ? encodeURIComponent(opts.text) : null;
  switch (action) {
    case 'whatsapp': {
      if (!digits) return null;
      const mode = opts.whatsapp ?? 'auto';
      if (mode === 'app') return `whatsapp://send?phone=${digits}${text ? `&text=${text}` : ''}`;
      if (mode === 'web') return `https://web.whatsapp.com/send?phone=${digits}${text ? `&text=${text}` : ''}`;
      return `https://wa.me/${digits}${text ? `?text=${text}` : ''}`;
    }
    case 'telegram': {
      const user = telegramUsername(opts.telegramUsername);
      if (user) return `https://t.me/${user}`;
      return digits ? `https://t.me/+${digits}` : null;
    }
    case 'call': {
      if (e164) return `tel:${e164}`;
      const dial = phone.phone.replace(/[^\d+*#]/g, '');
      return dial ? `tel:${dial.replace(/#/g, '%23')}` : null;
    }
    case 'sms': {
      if (!e164) return null;
      if (!text) return `sms:${e164}`;
      return opts.platform === 'ios' ? `sms:${e164}&body=${text}` : `sms:${e164}?body=${text}`;
    }
    case 'copy':
      return null;
  }
};

/** What "copy" puts on the clipboard: the number as the user typed it (what they see). */
export const phoneCopyText = (phone: { phone: string }) => phone.phone.trim();

export type PhoneMenuContext = {
  /** May this user send SMS from the system (GET /sms/status `can_send`)? false hides "sms" unless `deviceSms`. */
  smsFromSystem?: boolean;
  /** SMS from the device's own app is possible (a phone / tablet). */
  deviceSms?: boolean;
  /** The row has a Telegram username (telegram then works even without a valid number). */
  telegramUsername?: string | null;
};

/**
 * The actions the menu of this cell shows, in the column's order: none when the column switched the feature off;
 * a number that is not valid keeps only "call" and "copy" (and "telegram" when a username is known).
 */
export const phoneMenuActions = (
  settings: unknown,
  info: Pick<PhoneInfo, 'valid'>,
  ctx: PhoneMenuContext = {},
): PhoneAction[] => {
  const cfg = phoneColumnConfig(settings);
  if (!cfg.enabled) return [];
  return cfg.actions.filter((a) => {
    if (a === 'telegram' && telegramUsername(ctx.telegramUsername)) return true;
    if (NEEDS_VALID.has(a) && !info.valid) return false;
    if (a === 'sms') return ctx.smsFromSystem !== false || !!ctx.deviceSms;
    return true;
  });
};

// ---- per-user preference (user_profile_settings.settings.phone_actions) ----

/** "When I click a phone number": the menu, the column's default action, or one action straight away. */
export const PHONE_CLICK_CHOICES = ['menu', 'column_default', ...PHONE_ACTIONS] as const;
export type PhoneClickChoice = (typeof PHONE_CLICK_CHOICES)[number];

export const phoneActionPrefsSchema = z.object({
  click: z.enum(PHONE_CLICK_CHOICES).default('menu'),
  /** WhatsApp on a computer: wa.me (auto), the desktop app, or WhatsApp Web. */
  whatsapp_desktop: z.enum(['auto', 'app', 'web']).default('auto'),
  /** SMS on a phone: ask each time, from the system (the account's SMS provider), or from the device's app. */
  sms_mobile: z.enum(['ask', 'system', 'device']).default('ask'),
});
export type PhoneActionPrefs = z.infer<typeof phoneActionPrefsSchema>;
export const DEFAULT_PHONE_PREFS: PhoneActionPrefs = phoneActionPrefsSchema.parse({});

/** Only the known values of a stored (untrusted JSON) preference. */
export const cleanPhonePrefs = (v: unknown): Partial<PhoneActionPrefs> => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const shape = phoneActionPrefsSchema.shape;
  const out: Partial<PhoneActionPrefs> = {};
  const click = shape.click.unwrap().safeParse(o.click);
  if (click.success) out.click = click.data;
  const wa = shape.whatsapp_desktop.unwrap().safeParse(o.whatsapp_desktop);
  if (wa.success) out.whatsapp_desktop = wa.data;
  const sms = shape.sms_mobile.unwrap().safeParse(o.sms_mobile);
  if (sms.success) out.sms_mobile = sms.data;
  return out;
};

/** PUT /me/phone-actions — any subset; null = back to the default. */
export const setPhoneActionPrefsSchema = z.object({
  click: z.enum(PHONE_CLICK_CHOICES).nullable().optional(),
  whatsapp_desktop: z.enum(['auto', 'app', 'web']).nullable().optional(),
  sms_mobile: z.enum(['ask', 'system', 'device']).nullable().optional(),
});
export type SetPhoneActionPrefs = z.infer<typeof setPhoneActionPrefsSchema>;

export const phoneActionPrefsResponseSchema = phoneActionPrefsSchema.extend({
  /** What the user chose themselves (a key left out = the default applies). */
  user: phoneActionPrefsSchema.partial(),
});
export type PhoneActionPrefsResponse = z.infer<typeof phoneActionPrefsResponseSchema>;

/**
 * What a plain click does: 'menu', or one action to run at once. The user's choice wins when the cell offers it;
 * otherwise (or 'menu') the menu opens. A cell with one action runs it directly; with none, nothing ('none').
 */
export const resolvePhoneClick = (
  prefs: Partial<PhoneActionPrefs> | null | undefined,
  settings: unknown,
  available: PhoneAction[],
): PhoneAction | 'menu' | 'none' => {
  if (!available.length) return 'none';
  if (available.length === 1) return available[0]!;
  const click = prefs?.click ?? 'menu';
  if (click === 'menu') return 'menu';
  const want = click === 'column_default' ? phoneColumnConfig(settings).defaultAction : click;
  return available.includes(want) ? want : 'menu';
};

/** What a long press / Ctrl+click does: the column's default action when the cell offers it, else the first one. */
export const phoneDefaultAction = (settings: unknown, available: PhoneAction[]): PhoneAction | null => {
  if (!available.length) return null;
  const def = phoneColumnConfig(settings).defaultAction;
  return available.includes(def) ? def : available[0]!;
};
