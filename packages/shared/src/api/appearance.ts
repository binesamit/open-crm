// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { CARD_USER_PX_RANGE, cleanCardWidth } from '../views/card-width';

/**
 * Round 13 ("font size per user"): the interface's text size and the table's density, per user — kept in the
 * user's profile settings (`user_profile_settings.settings.appearance`), so every device of theirs gets it. A device
 * may override it locally (web: `lib/appearance.ts`). Everything scales together: the root font size (rem — text,
 * spacing, controls, icons) by `TEXT_SCALE`, the table's row heights by text scale × `DENSITY_SCALE`.
 */
export const TEXT_SIZES = ['small', 'normal', 'large', 'xlarge'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SCALE: Record<TextSize, number> = { small: 0.9, normal: 1, large: 1.12, xlarge: 1.25 };

export const DENSITIES = ['compact', 'normal', 'comfortable'] as const;
export type Density = (typeof DENSITIES)[number];
/** Row height multiplier of the board table (and the other dense lists) on top of the text scale. */
export const DENSITY_SCALE: Record<Density, number> = { compact: 0.84, normal: 1, comfortable: 1.2 };

/**
 * r16motion (product decision — "subtle things only"): the user's animations — `system` follows
 * the device (prefers-reduced-motion), else `full` / `reduced` (fades, no movement, no exit animations) / `off`.
 * Kept beside the text size (per user, every device) but outside `Appearance`, which sizes rows.
 */
export const MOTION_PREFS = ['system', 'full', 'reduced', 'off'] as const;
export type MotionPref = (typeof MOTION_PREFS)[number];
/** What the interface actually does — `<html data-motion>`. */
export type MotionMode = Exclude<MotionPref, 'system'>;

/** The motion in effect: the user's choice, else the device's reduced-motion setting. */
export const resolveMotion = (pref: MotionPref | null | undefined, prefersReduced: boolean): MotionMode =>
  pref === 'full' || pref === 'reduced' || pref === 'off' ? pref : prefersReduced ? 'reduced' : 'full';

/** A stored (untrusted) motion choice, or undefined. */
export const cleanMotion = (v: unknown): MotionPref | undefined =>
  (MOTION_PREFS as readonly unknown[]).includes(v) ? (v as MotionPref) : undefined;

/**
 * Icon style (product decision: an icon look of our own): `duo` (the default) fills each
 * icon's main shape with a light tint of its colour; `line` is the earlier thin outline; `solid`, `sharp`, `bold` and
 * `accent` (one part in the brand amber) are the other approved looks. Per user (every device), with the account's
 * default (`defaults.icon_style`) for whoever never chose. Applied by the web `Icon` component.
 */
export const ICON_STYLES = ['duo', 'line', 'solid', 'sharp', 'bold', 'accent'] as const;
export type IconStyle = (typeof ICON_STYLES)[number];
export const DEFAULT_ICON_STYLE: IconStyle = 'duo';

/** A stored (untrusted) icon style, or undefined. */
export const cleanIconStyle = (v: unknown): IconStyle | undefined =>
  (ICON_STYLES as readonly unknown[]).includes(v) ? (v as IconStyle) : undefined;

/**
 * what a click on an address in an email column does — `ask` (the default) opens a small menu (Gmail
 * Outlook on the web, the device's mail app, copy); the others go straight there (the menu stays on right-click).
 * Per user (every device), with the account's default (`defaults.email_open`) for whoever never chose.
 */
export const EMAIL_OPENS = ['ask', 'gmail', 'outlook', 'mailto'] as const;
export type EmailOpen = (typeof EMAIL_OPENS)[number];
export const DEFAULT_EMAIL_OPEN: EmailOpen = 'ask';

/** A stored (untrusted) email-click choice, or undefined. */
export const cleanEmailOpen = (v: unknown): EmailOpen | undefined =>
  (EMAIL_OPENS as readonly unknown[]).includes(v) ? (v as EmailOpen) : undefined;

/** Where writing to `address` opens: a new message in Gmail / Outlook on the web, or the device's mail app. */
export const emailComposeUrl = (app: Exclude<EmailOpen, 'ask'>, address: string): string => {
  const to = encodeURIComponent(address.trim());
  if (app === 'gmail') return `https://mail.google.com/mail/?view=cm&fs=1&to=${to}`;
  if (app === 'outlook') return `https://outlook.office.com/mail/deeplink/compose?to=${to}`;
  return `mailto:${to}`;
};

export const appearanceSchema = z.object({
  text_size: z.enum(TEXT_SIZES).default('normal'),
  density: z.enum(DENSITIES).default('normal'),
});
export type Appearance = z.infer<typeof appearanceSchema>;

/** PUT /me/appearance — any subset; `null` clears the user's own choice (back to the default). */
export const setAppearanceSchema = z.object({
  text_size: z.enum(TEXT_SIZES).nullable().optional(),
  density: z.enum(DENSITIES).nullable().optional(),
  motion: z.enum(MOTION_PREFS).nullable().optional(),
  /** F9 cardw: my item card width (px, dragged); null = back to the account's default. */
  card_width: z.number().int().min(CARD_USER_PX_RANGE.min).max(CARD_USER_PX_RANGE.max).nullable().optional(),
  /** my icon style; null = back to the account's default. */
  icon_style: z.enum(ICON_STYLES).nullable().optional(),
  /** what a click on an email address does; null = back to the account's default. */
  email_open: z.enum(EMAIL_OPENS).nullable().optional(),
});
export type SetAppearance = z.infer<typeof setAppearanceSchema>;

export const appearanceResponseSchema = appearanceSchema.extend({
  /** r16motion: the user's animations choice (`system` = follow the device). */
  motion: z.enum(MOTION_PREFS).default('system'),
  /** F9 cardw: my item card width (px; the card clamps it to the window), null = the account's default. */
  card_width: z.number().int().nullable().default(null),
  /** the icon style in effect — mine, else the account's default, else `duo`. */
  icon_style: z.enum(ICON_STYLES).default(DEFAULT_ICON_STYLE),
  /** the email-click choice in effect — mine, else the account's default, else `ask`. */
  email_open: z.enum(EMAIL_OPENS).default(DEFAULT_EMAIL_OPEN),
  /** What the user chose themselves (a field left out = the default applies). */
  user: z.object({
    text_size: z.enum(TEXT_SIZES).optional(),
    density: z.enum(DENSITIES).optional(),
    motion: z.enum(MOTION_PREFS).optional(),
    card_width: z.number().int().optional(),
    icon_style: z.enum(ICON_STYLES).optional(),
    email_open: z.enum(EMAIL_OPENS).optional(),
  }),
  /**
   * The account's default (hook for the account admin's "appearance default" — not editable yet); null = none.
   * Applies to whatever the user did not choose.
   */
  account_default: z
    .object({
      text_size: z.enum(TEXT_SIZES).optional(),
      density: z.enum(DENSITIES).optional(),
      motion: z.enum(MOTION_PREFS).optional(),
      icon_style: z.enum(ICON_STYLES).optional(),
      email_open: z.enum(EMAIL_OPENS).optional(),
    })
    .nullable(),
});
export type AppearanceResponse = z.infer<typeof appearanceResponseSchema>;

type Partial =
  | {
      text_size?: unknown;
      density?: unknown;
      motion?: unknown;
      card_width?: unknown;
      icon_style?: unknown;
      email_open?: unknown;
    }
  | null
  | undefined;

type CleanAppearance = {
  text_size?: TextSize;
  density?: Density;
  motion?: MotionPref;
  card_width?: number;
  icon_style?: IconStyle;
  email_open?: EmailOpen;
};

/** Only the known values of a stored (untrusted JSON) appearance. */
export const cleanAppearance = (v: Partial): CleanAppearance => {
  const out: CleanAppearance = {};
  if (v && (TEXT_SIZES as readonly unknown[]).includes(v.text_size)) out.text_size = v.text_size as TextSize;
  if (v && (DENSITIES as readonly unknown[]).includes(v.density)) out.density = v.density as Density;
  const motion = cleanMotion(v?.motion);
  if (motion) out.motion = motion;
  const cardWidth = cleanCardWidth(v?.card_width);
  if (cardWidth !== undefined) out.card_width = cardWidth;
  const iconStyle = cleanIconStyle(v?.icon_style);
  if (iconStyle) out.icon_style = iconStyle;
  const emailOpen = cleanEmailOpen(v?.email_open);
  if (emailOpen) out.email_open = emailOpen;
  return out;
};

/** The appearance in effect: the user's choice, else the account's default, else normal / normal. */
export const resolveAppearance = (user: Partial, accountDefault?: Partial): Appearance => {
  const u = cleanAppearance(user);
  const a = cleanAppearance(accountDefault);
  return { text_size: u.text_size ?? a.text_size ?? 'normal', density: u.density ?? a.density ?? 'normal' };
};

/** A row height (px at normal size) at this appearance — whole pixels, so virtual lists add up exactly. */
export const scaledRowPx = (px: number, a: Appearance, dense = true) =>
  Math.round(px * TEXT_SCALE[a.text_size] * (dense ? DENSITY_SCALE[a.density] : 1));
