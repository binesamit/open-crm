// SPDX-License-Identifier: AGPL-3.0-only
import {
  phoneActionLink,
  phoneColumnConfig,
  phoneCopyText,
  phoneDefaultAction,
  phoneInfoOf,
  phoneMenuActions,
  resolvePhoneClick,
  type PhoneAction,
  type PhoneActionPrefs,
  type PhoneInfo,
  type PhonePlatform,
  type SmsStatus,
} from '@bines/shared';

/**
 * Phone cell click actions — the web side's pure logic. The links themselves always come from the
 * shared helpers (`phoneActionLink`, `phoneMenuActions`, `resolvePhoneClick`); this file only decides, for this
 * device and this user, what a click / long press / menu choice does.
 */

/** The device's family from its user agent (iPadOS reports a Mac with touch: `touch` says so). */
export const detectPlatform = (ua: string, touch = false): PhonePlatform => {
  if (/iPhone|iPad|iPod/i.test(ua) || (touch && /Macintosh/i.test(ua))) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
};

/** A phone / tablet: the device has its own dialer and SMS app. */
export const isMobilePlatform = (p: PhonePlatform) => p === 'ios' || p === 'android';

export type PhoneDevice = { platform: PhonePlatform; mobile: boolean };

export const currentDevice = (): PhoneDevice => {
  if (typeof navigator === 'undefined') return { platform: 'other', mobile: false };
  const platform = detectPlatform(navigator.userAgent, (navigator.maxTouchPoints ?? 0) > 1);
  return { platform, mobile: isMobilePlatform(platform) };
};

type CellValue = { phone?: unknown } | null | undefined;

/** The number as typed (the display text), or '' for an empty / odd cell. */
export const phoneText = (value: unknown): string => {
  const p = (value as CellValue)?.phone;
  return typeof p === 'string' ? p : '';
};

export type CellPhoneContext = {
  settings: unknown;
  value: unknown;
  /** GET /sms/status (undefined while loading or when it failed: SMS from the system is then not offered). */
  sms?: Pick<SmsStatus, 'can_send' | 'account_country'> | null;
  device: PhoneDevice;
  /** The text of the column chosen as `telegram_username_column`, in this row. */
  telegramRaw?: string | null;
};

export type CellPhone = {
  phone: string;
  info: PhoneInfo;
  /** The actions this cell offers (empty when the column switched the feature off). */
  actions: PhoneAction[];
  enabled: boolean;
};

/** What one phone cell offers: its number, E.164 / validity and the actions of its menu. */
export const cellPhone = (c: CellPhoneContext): CellPhone => {
  const cfg = phoneColumnConfig(c.settings);
  const phone = phoneText(c.value);
  const info = phoneInfoOf(c.value, cfg.defaultCountry, c.sms?.account_country ?? null);
  const actions = phone
    ? phoneMenuActions(c.settings, info, {
        smsFromSystem: !!c.sms?.can_send,
        deviceSms: c.device.mobile,
        telegramUsername: c.telegramRaw ?? null,
      })
    : [];
  return { phone, info, actions, enabled: cfg.enabled };
};

/** What a gesture on the number does: a plain click (the user's preference), or Ctrl+click / long press. */
export const clickTarget = (
  gesture: 'click' | 'default',
  prefs: Partial<PhoneActionPrefs> | null | undefined,
  settings: unknown,
  actions: PhoneAction[],
): PhoneAction | 'menu' | 'none' =>
  gesture === 'default'
    ? (phoneDefaultAction(settings, actions) ?? 'none')
    : resolvePhoneClick(prefs, settings, actions);

/** What running one action means on this device. */
export type PhoneStep =
  | { kind: 'open'; href: string; newTab: boolean }
  | { kind: 'copy'; text: string }
  /** A computer: show the number (copy it, or try the tel: handler) — there may be no calling app. */
  | { kind: 'call-panel'; href: string | null; text: string }
  /** The SMS dialog (templates, preview, send from the system); `device` = also offer the phone's own SMS app. */
  | { kind: 'sms-dialog'; device: string | null }
  | { kind: 'none' };

export const planPhoneAction = (
  action: PhoneAction,
  cell: Pick<CellPhone, 'phone' | 'info'>,
  o: {
    device: PhoneDevice;
    prefs?: Partial<PhoneActionPrefs> | null;
    smsFromSystem: boolean;
    telegramRaw?: string | null;
  },
): PhoneStep => {
  const p = { phone: cell.phone, e164: cell.info.e164 };
  const prefs = o.prefs ?? {};
  switch (action) {
    case 'copy':
      return { kind: 'copy', text: phoneCopyText(p) };
    case 'whatsapp': {
      // A phone always uses wa.me (it opens the app); a computer follows "WhatsApp on desktop".
      const href = phoneActionLink('whatsapp', p, { whatsapp: o.device.mobile ? 'auto' : prefs.whatsapp_desktop });
      if (!href) return { kind: 'none' };
      return { kind: 'open', href, newTab: !href.startsWith('whatsapp:') };
    }
    case 'telegram': {
      const href = phoneActionLink('telegram', p, { telegramUsername: o.telegramRaw ?? null });
      return href ? { kind: 'open', href, newTab: true } : { kind: 'none' };
    }
    case 'call': {
      const href = phoneActionLink('call', p);
      if (o.device.mobile) return href ? { kind: 'open', href, newTab: false } : { kind: 'none' };
      return { kind: 'call-panel', href, text: phoneCopyText(p) };
    }
    case 'sms': {
      const device = o.device.mobile ? phoneActionLink('sms', p, { platform: o.device.platform }) : null;
      if (!o.smsFromSystem) return device ? { kind: 'open', href: device, newTab: false } : { kind: 'none' };
      if (device && prefs.sms_mobile === 'device') return { kind: 'open', href: device, newTab: false };
      return { kind: 'sms-dialog', device: device && prefs.sms_mobile !== 'system' ? device : null };
    }
  }
};

/** i18n key of an SMS send failure (POST /items/{id}/sms), or null to fall back to the generic error text. */
export const smsErrorKey = (err: unknown): string | null => {
  const body = (err as { body?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.body;
  if (!body?.code) return null;
  const reason = typeof body.details?.reason === 'string' ? body.details.reason : null;
  switch (body.code) {
    case 'forbidden':
      if (body.message === 'sms_off_for_column') return 'phone.sms.error.offForColumn';
      return reason ? `phone.sms.error.denied.${reason}` : 'phone.sms.error.denied.disabled';
    case 'sms_unsupported_number':
      return reason === 'unsupported_destination' ? 'phone.sms.error.destination' : 'phone.sms.error.invalid';
    case 'rate_limited':
      return reason === 'sms_account_limit' ? 'phone.sms.error.accountLimit' : 'phone.sms.error.userLimit';
    case 'sms_not_configured':
      return 'phone.sms.error.notConfigured';
    case 'external_error':
      return 'phone.sms.error.provider';
    case 'validation_failed':
      if (body.message === 'sms_too_long') return 'phone.sms.error.tooLong';
      if (body.message === 'sms_empty_text') return 'phone.sms.error.empty';
      return null;
    default:
      return null;
  }
};

/** A Telegram username column must be a text column of the same board. */
export const telegramColumnCandidates = <C extends { id: string; type: string }>(columns: C[]) =>
  columns.filter((c) => c.type === 'text');

/** Column settings form → the settings object (the whole object is replaced on save). */
export const buildPhoneSettings = (
  prev: Record<string, unknown>,
  f: {
    enabled: boolean;
    actions: PhoneAction[];
    defaultAction: PhoneAction;
    defaultCountry: string | null;
    telegramColumn: string | null;
  },
): Record<string, unknown> => {
  const actions = f.actions.length ? f.actions : (['call', 'copy'] as PhoneAction[]);
  const next: Record<string, unknown> = {
    ...prev,
    click_actions_enabled: f.enabled,
    actions,
    default_action: actions.includes(f.defaultAction) ? f.defaultAction : actions[0],
    telegram_username_column: f.telegramColumn,
  };
  if (f.defaultCountry) next.default_country = f.defaultCountry;
  else delete next.default_country;
  return next;
};

/** Move one action up / down in the ordered list (the menu shows them in this order). */
export const moveAction = (list: PhoneAction[], action: PhoneAction, by: -1 | 1): PhoneAction[] => {
  const i = list.indexOf(action);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};
