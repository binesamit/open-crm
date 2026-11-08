// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  DEFAULT_EMAIL_ACCENT,
  DEFAULT_MAIL_STYLE,
  type MailStyle,
  dirOf,
  formatHebrewDate,
  type IsoDate,
  type Locale,
  type MailTemplateKey,
  type MessageKey,
  notificationSentence,
  t,
} from '@bines/shared';
import type { EmailMessage } from './mailer';
import { type Hero, avatarColor, ctaPill, heroInfo, initialOf, renderHero, threadBody } from './objects';
export type { Hero } from './objects';
import { C, D, DISPLAY, FONT, escapeHtml, fadesInDark, linkColor, onAccent } from './palette';

/**
 * Transactional emails (D12, ANSWERS 6א.3, M11): in the RECIPIENT's language (he = RTL, en = LTR), with the account's
 * (or the platform's) sender name, Reply-To, logo and accent colour, and the platform's product name — nothing
 * branded in code. One layout for all of them: tables and inline styles only (no external CSS), a header with the
 * logo and name, a footer that says why the recipient got it, a plain-text part, and colours that survive dark mode.
 */
export { escapeHtml, onAccent } from './palette';
const escape = escapeHtml;

/** Who an email comes from and how it reads: built by `mailBrand` from the platform and account settings. */
export type MailBrand = {
  /** The recipient's language. */
  locale: Locale;
  /** The product's name (owner console, white-label; default = i18n `app.name`). */
  product: string;
  /** The From display name. */
  senderName: string;
  replyTo?: string | null;
  /** An absolute URL of the logo shown on top (the account's email logo), or null. */
  logoUrl?: string | null;
  /** The name in the header: the account's, or the product's for an email of no account. */
  name: string;
  /** The accent (#rrggbb): the account's, else the owner's, else the platform's colour. */
  accent: string;
  /**
   * How the emails look (canvas 2026-11-04): `objects` = every email with its own picture (key-card, luggage tag,
   * newspaper…), `classic` = the plain card. The account's choice, else the owner's; absent = classic.
   */
  style?: MailStyle;
};

export type { MailStyle } from '@bines/shared';

/** Platform settings fields the brand reads (owner console). */
export type PlatformMailSettings = {
  product_name?: string;
  email?: { sender_name?: string; reply_to?: string; accent_color?: string; style?: MailStyle };
} | null;

/** Account branding fields the brand reads (Administration → Emails & SMS). */
export type AccountMailSettings = {
  name: string;
  branding?: {
    email_sender_name?: string;
    email_reply_to?: string;
    email_accent_color?: string;
    email_style?: MailStyle;
  } | null;
} | null;

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Only a plain #rrggbb ever reaches a style attribute (settings are validated, this is the last guard). */
const hexOr = (value: string | undefined | null, fallback: string) =>
  value && HEX.test(value.trim()) ? value.trim().toLowerCase() : fallback;

/**
 * The brand of one email. An account's email: the account's sender name (default = its name), Reply-To and accent.
 * An email of no account (sign-in link, password reset): the platform's sender name (default = the product name).
 */
export const mailBrand = (p: {
  locale: Locale;
  platform?: PlatformMailSettings;
  account?: AccountMailSettings;
  logoUrl?: string | null;
}): MailBrand => {
  const product = p.platform?.product_name?.trim() || t('app.name', undefined, p.locale);
  const senderName = p.account
    ? p.account.branding?.email_sender_name?.trim() || p.account.name
    : p.platform?.email?.sender_name?.trim() || product;
  const replyTo = p.account ? p.account.branding?.email_reply_to : p.platform?.email?.reply_to;
  const platformAccent = hexOr(p.platform?.email?.accent_color, DEFAULT_EMAIL_ACCENT);
  return {
    locale: p.locale,
    product,
    senderName,
    replyTo: replyTo || null,
    logoUrl: p.logoUrl ?? null,
    name: p.account?.name || product,
    accent: hexOr(p.account?.branding?.email_accent_color, platformAccent),
    style: p.account?.branding?.email_style ?? p.platform?.email?.style ?? DEFAULT_MAIL_STYLE,
  };
};

/* ---------- the layout ---------- */

const m = (b: MailBrand, key: string, vars?: Record<string, string | number>) => t(key as MessageKey, vars, b.locale);

/** Escapes every value, for a sentence that goes into HTML. */
const mh = (b: MailBrand, key: string, vars: Record<string, string | number> = {}) =>
  m(b, key, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? escape(v) : v])));

const from = (b: MailBrand) => ({ fromName: b.senderName, ...(b.replyTo ? { replyTo: b.replyTo } : {}) });

/** Why the recipient got the email: HTML (may hold a link) and plain text. */
type Reason = { html: string; text: string };
const reasonOf = (text: string): Reason => ({ html: escape(text), text });

type Content = {
  subject: string;
  /** The heading inside the email (plain text). */
  title: string;
  /** The body, already safe HTML (every user value escaped). */
  bodyHtml: string;
  /** The same body as plain-text lines (empty ones are dropped). */
  bodyText: (string | null | undefined)[];
  cta?: { label: string; url: string };
  reason: Reason;
  /** The picture of the `objects` style (ignored by the classic layout). */
  hero?: Hero;
};

/**
 * Dark mode: clients that honour `prefers-color-scheme` get the F3 palette from the head; the ones that invert on
 * their own (Gmail app, Outlook.com `[data-ogsc]`) start from explicit light colours with `bgcolor`s, so the result
 * stays readable. The logo sits on its own white chip so a dark logo never vanishes; an accent too dark for the dark
 * card turns light (`bos-acc`). Everything that matters is inline (clients that drop <style> lose only dark mode).
 */
const darkCss = (accent: string) => `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.bos-bg{background-color:${D.page}!important}
.bos-card{background-color:${D.card}!important;border-color:${D.line}!important}
.bos-line{border-color:${D.line}!important}
.bos-head{color:${D.heading}!important}
.bos-ink{color:${D.ink}!important}
.bos-body{color:${D.body}!important}
.bos-muted{color:${D.muted}!important}
.bos-quote{background-color:${D.soft}!important;color:${D.ink}!important}
.bos-link{color:${D.ink}!important}
${fadesInDark(accent) ? `.bos-acc{background-color:${D.heading}!important;color:${accent}!important}` : ''}
}
[data-ogsc] .bos-card{background-color:${D.card}!important}
[data-ogsc] .bos-head{color:${D.heading}!important}
[data-ogsc] .bos-ink,[data-ogsc] .bos-body{color:${D.ink}!important}
[data-ogsc] .bos-muted{color:${D.muted}!important}
@media only screen and (max-width:600px){
.bos-outer{padding:24px 8px!important}
.bos-pad{padding-left:24px!important;padding-right:24px!important}
.bos-title{font-size:20px!important}
}`;

/** The account's mark in the header: its logo (on a white chip), else a small monogram in the accent. */
const mark = (b: MailBrand) => {
  if (b.logoUrl)
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background-color:#ffffff;border-radius:7px;padding:3px"><img src="${escape(b.logoUrl)}" alt="${escape(b.name)}" height="28" style="display:block;height:28px;width:auto;max-width:160px;border:0;outline:none;text-decoration:none"></td></tr></table>`;
  const initial = Array.from(b.name.trim())[0]?.toUpperCase() ?? '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="bos-acc" bgcolor="${b.accent}" width="28" height="28" align="center" valign="middle" style="width:28px;height:28px;background-color:${b.accent};border-radius:7px;font-family:${FONT};font-size:14px;font-weight:700;line-height:28px;color:${onAccent(b.accent)};text-align:center">${escape(initial)}</td></tr></table>`;
};

const html = (b: MailBrand, c: Content) => {
  const dir = dirOf(b.locale);
  const start = dir === 'rtl' ? 'right' : 'left';
  const end = dir === 'rtl' ? 'left' : 'right';
  const accent = b.accent;
  const face = `font-family:${FONT};text-align:${start}`;
  const cta = c.cta
    ? `<tr><td class="bos-pad" align="${start}" style="padding:18px 40px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="bos-acc" bgcolor="${accent}" style="background-color:${accent};border-radius:7px;mso-padding-alt:12px 22px"><a class="bos-acc" href="${escape(c.cta.url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${onAccent(accent)};text-decoration:none;border-radius:7px">${escape(c.cta.label)}</a></td></tr></table></td></tr>
<tr><td class="bos-pad" style="padding:32px 40px 36px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="bos-line bos-muted" align="${start}" style="border-top:1px solid ${C.line};padding-top:20px;${face};font-size:13px;line-height:1.6;color:${C.muted}">${escape(m(b, 'mail.linkFallback'))}<br><a class="bos-link" href="${escape(c.cta.url)}" target="_blank" dir="ltr" style="color:${C.body};text-decoration:underline;word-break:break-all">${escape(c.cta.url)}</a></td></tr></table></td></tr>`
    : '<tr><td style="padding:0 0 26px;font-size:0;line-height:0">&nbsp;</td></tr>';
  return `<!doctype html>
<html dir="${dir}" lang="${b.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(c.subject)}</title>
<style>${darkCss(accent)}</style>
</head>
<body class="bos-bg" dir="${dir}" style="margin:0;padding:0;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escape(c.title)}</div>
<table role="presentation" class="bos-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" dir="${dir}" style="background-color:${C.page}">
<tr><td class="bos-outer" align="center" style="padding:48px 16px">
<table role="presentation" class="bos-card" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" dir="${dir}" style="width:100%;max-width:560px;background-color:${C.card};border:1px solid ${C.line};border-radius:12px;border-collapse:separate">
<tr><td class="bos-pad" align="${start}" style="padding:32px 40px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${dir}"><tr><td valign="middle" style="padding-${end}:10px">${mark(b)}</td><td valign="middle" class="bos-ink" style="${face};font-size:14px;font-weight:600;line-height:20px;color:${C.ink}">${escape(b.name)}</td></tr></table></td></tr>
<tr><td class="bos-pad bos-head bos-title" align="${start}" style="padding:32px 40px 0;${face};font-size:22px;line-height:1.35;font-weight:700;letter-spacing:-0.2px;color:${C.heading}">${escape(c.title)}</td></tr>
<tr><td class="bos-pad bos-body" align="${start}" style="padding:12px 40px 0;${face};font-size:15px;line-height:1.65;color:${C.body}">${c.bodyHtml}</td></tr>
${cta}
</table>
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:560px">
<tr><td class="bos-pad bos-muted" align="${start}" style="padding:24px 41px 0;${face};font-size:12px;line-height:1.6;color:${C.muted}">${c.reason.html}</td></tr>
<tr><td class="bos-pad bos-muted" align="${start}" style="padding:8px 41px 0;${face};font-size:12px;line-height:1.6;color:${C.muted}">${escape(m(b, 'mail.footer.product', { product: b.product }))}</td></tr>
</table>
</td></tr></table>
</body></html>`;
};

/** Dark mode for the objects' own classes (tinted blocks), on top of the classic rules. */
const objectsDarkCss = `@media (prefers-color-scheme:dark){.bos-tint{background-color:${D.soft}!important;border-color:${D.line}!important;color:${D.ink}!important}}
@media only screen and (max-width:600px){.bos-big{font-size:46px!important}}`;

/**
 * The objects layout (canvas 2026-11-04): a rounded card, the account's mark, the email's picture (objects.ts),
 * a large heading in the display face, the body, a pill button, the copy-the-link line, and why it was sent. The
 * account's own voice (automations, documents, replies) gets a letterhead band in the accent along the card.
 */
const htmlObjects = (b: MailBrand, c: Content) => {
  const dir = dirOf(b.locale);
  const start = dir === 'rtl' ? 'right' : 'left';
  const end = dir === 'rtl' ? 'left' : 'right';
  const info = heroInfo(c.hero);
  const accent = info.muted ? C.muted : b.accent;
  const face = `font-family:${FONT};text-align:${start}`;
  const hero = c.hero
    ? renderHero(c.hero, { accent, start, end, dir, title: c.title, ...(c.cta ? { cta: c.cta } : {}) })
    : '';
  const short = Array.from(c.title).length <= 26;
  const heading = info.ownsTitle
    ? ''
    : `<tr><td class="bos-pad bos-head ${short ? 'bos-big' : 'bos-title'}" align="${start}" style="padding:${info.first || !c.hero ? 26 : 30}px 34px 0;${face};${
        short
          ? `font-family:${DISPLAY};font-size:60px;line-height:.95`
          : 'font-size:24px;line-height:1.3;letter-spacing:-0.2px'
      };font-weight:400;color:${C.heading}">${escape(c.title)}</td></tr>`;
  const brandRow = info.noBrand
    ? ''
    : `<tr><td class="bos-pad" align="${start}" style="padding:28px 34px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${dir}"><tr><td valign="middle" style="padding-${end}:10px">${info.muted ? '' : mark(b)}</td><td valign="middle" class="${info.muted ? 'bos-muted' : 'bos-ink'}" style="${face};font-size:14px;font-weight:500;line-height:20px;color:${info.muted ? C.muted : C.ink}">${escape(b.name)}</td></tr></table></td></tr>`;
  const body = c.bodyHtml
    ? `<tr><td class="bos-pad bos-body" align="${start}" style="padding:14px 34px 0;${face};font-size:15.5px;line-height:1.65;color:${C.body}">${c.bodyHtml}</td></tr>`
    : '';
  const button =
    c.cta && !info.ownsCta
      ? `<tr><td class="bos-pad" align="${start}" style="padding:20px 34px 0">${ctaPill(c.cta.label, c.cta.url, accent)}</td></tr>`
      : '';
  const fallback = c.cta
    ? `<tr><td class="bos-pad" style="padding:28px 34px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="bos-line bos-muted" align="${start}" style="border-top:1px dashed ${C.line};padding-top:16px;${face};font-size:12px;line-height:1.6;color:${C.muted}">${escape(m(b, 'mail.linkFallback'))}<br><a class="bos-link" href="${escape(c.cta.url)}" target="_blank" dir="ltr" style="color:${C.body};text-decoration:underline;word-break:break-all">${escape(c.cta.url)}</a></td></tr></table></td></tr>`
    : '<tr><td style="padding:0 0 30px;font-size:0;line-height:0">&nbsp;</td></tr>';
  const rows = info.first
    ? `${brandRow}${hero}${heading}${body}${button}${fallback}`
    : `${brandRow}${heading}${hero}${body}${button}${fallback}`;
  const inner = info.band
    ? `<tr><td valign="top" style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}">${rows}</table></td><td class="bos-acc" width="56" bgcolor="${accent}" style="width:56px;background-color:${accent};border-radius:${start === 'right' ? '0 20px 20px 0' : '20px 0 0 20px'}">&nbsp;</td></tr>`
    : rows;
  return `<!doctype html>
<html dir="${dir}" lang="${b.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(c.subject)}</title>
<style>${darkCss(accent)}
${objectsDarkCss}</style>
</head>
<body class="bos-bg" dir="${dir}" style="margin:0;padding:0;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escape(c.title)}</div>
<table role="presentation" class="bos-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" dir="${dir}" style="background-color:${C.page}">
<tr><td class="bos-outer" align="center" style="padding:44px 16px">
<table role="presentation" class="bos-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" dir="${dir}" style="width:100%;max-width:600px;background-color:${C.card};border:1px solid ${C.line};border-radius:20px;border-collapse:separate">
${inner}
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:600px">
<tr><td class="bos-pad bos-muted" align="${start}" style="padding:18px 30px 0;${face};font-size:11.5px;line-height:1.6;color:${C.muted}">${c.reason.html}</td></tr>
<tr><td class="bos-pad bos-muted" align="${start}" style="padding:6px 30px 0;${face};font-size:11.5px;line-height:1.6;color:${C.muted}">${escape(m(b, 'mail.footer.product', { product: b.product }))}</td></tr>
</table>
</td></tr></table>
</body></html>`;
};

/** The plain-text part: the same content, in the same order, links spelled out. */
const text = (b: MailBrand, c: Content) =>
  [
    b.name,
    '',
    c.title,
    '',
    ...c.bodyText.filter((l): l is string => !!l),
    ...(c.cta ? ['', `${c.cta.label}: ${c.cta.url}`] : []),
    '',
    '--',
    c.reason.text,
    m(b, 'mail.footer.product', { product: b.product }),
  ].join('\n');

/** One email in the branded layout. */
const render = (to: string, b: MailBrand, c: Content): EmailMessage => ({
  to,
  ...from(b),
  subject: c.subject,
  html: b.style === 'objects' ? htmlObjects(b, c) : html(b, c),
  text: text(b, c),
});

const p = (inner: string) => `<p style="margin:0 0 14px">${inner}</p>`;
const quote = (value: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px"><tr><td class="bos-quote" bgcolor="${C.soft}" style="background-color:${C.soft};border-radius:7px;padding:14px 16px;white-space:pre-wrap;color:${C.ink}">${escape(value)}</td></tr></table>`;

/* ---------- the emails ---------- */

/** Days an invitation link is valid (invitations.service issues it for the same span). */
export const INVITATION_DAYS = 7;

export const invitationEmail = (x: {
  to: string;
  brand: MailBrand;
  accountName: string;
  inviterName: string | null;
  role: AccountRole;
  url: string;
  message?: string;
  /** The account's people (names, up to 5): the seats already taken on the invitation (objects style). */
  team?: string[];
}): EmailMessage => {
  const b = x.brand;
  const role = m(b, `role.${x.role}`);
  const whoText = x.inviterName ? m(b, 'mail.invite.byWho', { inviter: x.inviterName }) : m(b, 'mail.invite.byNobody');
  const whoHtml = x.inviterName ? mh(b, 'mail.invite.byWho', { inviter: x.inviterName }) : escape(whoText);
  const valid = m(b, 'mail.invite.valid', { days: INVITATION_DAYS });
  const reason = `${m(b, 'mail.reason.invite', { email: x.to, account: x.accountName })} ${m(b, 'mail.footer.ignore')}`;
  const objects = b.style === 'objects';
  const team = (x.team ?? []).filter(Boolean).slice(0, 5);
  return render(x.to, b, {
    subject: m(b, 'mail.invite.subject', { account: x.accountName, product: b.product }),
    title: objects ? m(b, 'mail.obj.invite.title') : m(b, 'mail.invite.title', { account: x.accountName }),
    hero: {
      kind: 'seats',
      people: team.map((n) => ({ initial: initialOf(n), color: avatarColor(n) })),
      me: m(b, 'mail.obj.invite.me'),
      ...(team.length ? { caption: m(b, 'mail.obj.invite.team', { n: team.length }) } : {}),
      ...(x.message ? { note: { text: x.message, ...(x.inviterName ? { by: x.inviterName } : {}) } } : {}),
      days: { total: INVITATION_DAYS, label: valid },
    },
    bodyHtml: objects
      ? p(
          m(b, 'mail.invite.body', {
            who: whoHtml,
            account: `<b>${escape(x.accountName)}</b>`,
            role: `<b>${escape(role)}</b>`,
          }),
        )
      : p(
          m(b, 'mail.invite.body', {
            who: whoHtml,
            account: `<b>${escape(x.accountName)}</b>`,
            role: `<b>${escape(role)}</b>`,
          }),
        ) +
        (x.message ? quote(x.message) : '') +
        p(escape(valid)),
    bodyText: [m(b, 'mail.invite.body', { who: whoText, account: x.accountName, role }), x.message, valid],
    cta: { label: m(b, 'mail.invite.cta'), url: x.url },
    reason: reasonOf(reason),
  });
};

/** Minutes a sign-in link is valid (auth.ts issues it for the same span). */
export const MAGIC_LINK_MINUTES = 10;

export const magicLinkEmail = (x: {
  to: string;
  brand: MailBrand;
  url: string;
  /** Who asked (objects style): the browser / system and the time, already in the recipient's language. */
  context?: { device?: string | null; when?: string | null };
}): EmailMessage => {
  const b = x.brand;
  const body = m(b, 'mail.magic.body', { minutes: MAGIC_LINK_MINUTES });
  const context: [string, string][] = [
    ...(x.context?.device ? [[m(b, 'mail.obj.magic.device'), x.context.device] as [string, string]] : []),
    ...(x.context?.when ? [[m(b, 'mail.obj.magic.when'), x.context.when] as [string, string]] : []),
  ];
  return render(x.to, b, {
    subject: m(b, 'mail.magic.subject', { product: b.product }),
    title: b.style === 'objects' ? m(b, 'mail.obj.magic.title') : m(b, 'mail.magic.title', { product: b.product }),
    hero: {
      kind: 'key',
      minutes: MAGIC_LINK_MINUTES,
      minutesLabel: m(b, 'mail.obj.magic.minutes'),
      sub: m(b, 'mail.obj.magic.sub', { product: b.product }),
      email: x.to,
      ...(context.length ? { context } : {}),
    },
    bodyHtml: p(escape(body)),
    bodyText: [m(b, 'mail.magic.text', { product: b.product, minutes: MAGIC_LINK_MINUTES })],
    cta: { label: m(b, 'mail.magic.cta'), url: x.url },
    reason: reasonOf(
      `${m(b, 'mail.reason.signIn', { email: x.to, product: b.product })} ${m(b, 'mail.footer.ignore')}`,
    ),
  });
};

export const resetPasswordEmail = (x: { to: string; brand: MailBrand; url: string }): EmailMessage => {
  const b = x.brand;
  return render(x.to, b, {
    subject: m(b, 'mail.reset.subject', { product: b.product }),
    title: m(b, 'mail.reset.title'),
    hero: { kind: 'dial', label: m(b, 'mail.obj.reset.dial') },
    bodyHtml: p(escape(m(b, 'mail.reset.body'))),
    bodyText: [m(b, 'mail.reset.text', { product: b.product })],
    cta: { label: m(b, 'mail.reset.cta'), url: x.url },
    reason: reasonOf(`${m(b, 'mail.reason.reset', { email: x.to, product: b.product })} ${m(b, 'mail.footer.ignore')}`),
  });
};

/**
 * A short security notice to an account's admins (remote support access, the emergency recovery link): a title,
 * plain lines, an optional button. The caller passes the sentences already in the recipient's language.
 */
/** Links under a notice's text (e.g. the help articles a support reply attached): a heading, then one row each. */
export type NoticeLinks = { title: string; items: { label: string; url: string; note?: string }[] };

const noticeLinksHtml = (b: MailBrand, l: NoticeLinks) => {
  const link = linkColor(b.accent);
  const rows = l.items
    .map((i) => {
      const note = i.note
        ? `<br><span class="bos-muted" style="color:${C.muted};font-size:14px">${escape(i.note)}</span>`
        : '';
      return `<li class="bos-line" style="margin:0;padding:12px 0;border-bottom:1px solid ${C.line}"><a class="bos-link" href="${escape(i.url)}" target="_blank" style="color:${link};font-weight:600;text-decoration:none">${escape(i.label)}</a>${note}</li>`;
    })
    .join('');
  return `${p(`<strong>${escape(l.title)}</strong>`)}<ul style="margin:0 0 14px;padding:0;list-style:none">${rows}</ul>`;
};

const noticeLinksText = (l: NoticeLinks) => [
  l.title,
  ...l.items.map((i) => `• ${i.label}${i.note ? `\n  ${i.note}` : ''}\n  ${i.url}`),
];

export const noticeEmail = (x: {
  to: string;
  brand: MailBrand;
  subject: string;
  title: string;
  lines: string[];
  links?: NoticeLinks;
  cta?: { label: string; url: string };
  reason: string;
  /** The picture of the objects style (a ticket's tag, a trial's calendar…). */
  hero?: Hero;
}): EmailMessage =>
  render(x.to, x.brand, {
    subject: x.subject,
    title: x.title,
    ...(x.hero ? { hero: x.hero } : {}),
    bodyHtml:
      (x.hero?.kind === 'thread' && x.brand.style === 'objects' && x.lines.length
        ? threadBody(
            x.lines,
            x.hero.who,
            x.hero.when,
            x.brand.accent,
            dirOf(x.brand.locale) === 'rtl' ? 'right' : 'left',
          )
        : x.lines.map((l) => p(escape(l))).join('')) + (x.links?.items.length ? noticeLinksHtml(x.brand, x.links) : ''),
    bodyText: [...x.lines, ...(x.links?.items.length ? noticeLinksText(x.links) : [])],
    ...(x.cta ? { cta: x.cta } : {}),
    reason: reasonOf(x.reason),
  });

/* --------- interactive documents ---------- */

/**
 * The link to an interactive document, from the account. `subject` / `body` are the document's own wording (merge
 * fields already filled); empty = the built-in wording.
 */
export const idocLinkEmail = (x: {
  to: string;
  brand: MailBrand;
  docName: string;
  url: string;
  subject?: string;
  body?: string;
  expires?: string;
}): EmailMessage => {
  const b = x.brand;
  const body = x.body?.trim() || m(b, 'mail.idoc.body', { account: b.name, doc: x.docName });
  const lines = [body, ...(x.expires ? [m(b, 'mail.idoc.expires', { date: x.expires })] : [])];
  return render(x.to, b, {
    subject: x.subject?.trim() || m(b, 'mail.idoc.subject', { doc: x.docName, account: b.name }),
    title: x.docName,
    hero: { kind: 'letterhead' },
    bodyHtml: lines.map((l) => `<div style="margin:0 0 14px;white-space:pre-wrap">${escape(l)}</div>`).join(''),
    bodyText: [...lines, x.url],
    cta: { label: m(b, 'mail.idoc.cta'), url: x.url },
    reason: reasonOf(m(b, 'mail.reason.automation', { account: b.name })),
  });
};

/** Minutes a document's one-time code is valid. */
export const IDOC_CODE_MINUTES = 10;

/** The one-time code that opens a document (sent to the contact's address). */
export const idocCodeEmail = (x: { to: string; brand: MailBrand; docName: string; code: string }): EmailMessage => {
  const b = x.brand;
  return render(x.to, b, {
    subject: m(b, 'mail.idocCode.subject', { code: x.code }),
    title: m(b, 'mail.idocCode.title', { doc: x.docName }),
    hero: { kind: 'letterhead' },
    bodyHtml:
      p(escape(m(b, 'mail.idocCode.body', { minutes: IDOC_CODE_MINUTES }))) +
      `<p style="margin:0 0 14px;font-size:28px;letter-spacing:6px;font-family:monospace" dir="ltr">${escape(x.code)}</p>`,
    bodyText: [m(b, 'mail.idocCode.body', { minutes: IDOC_CODE_MINUTES }), x.code],
    reason: reasonOf(`${m(b, 'mail.reason.automation', { account: b.name })} ${m(b, 'mail.footer.ignore')}`),
  });
};

/** The signer's copy: what they signed, when, the content fingerprint and the link back to the page. */
export const idocSignedEmail = (x: {
  to: string;
  brand: MailBrand;
  docName: string;
  signer: string;
  at: string;
  sha256: string;
  summary: string[];
  url: string;
}): EmailMessage => {
  const b = x.brand;
  const lines = [m(b, 'mail.idocSigned.body', { doc: x.docName, signer: x.signer, at: x.at }), ...x.summary];
  return render(x.to, b, {
    subject: m(b, 'mail.idocSigned.subject', { doc: x.docName }),
    title: m(b, 'mail.idocSigned.title', { doc: x.docName }),
    hero: { kind: 'letterhead' },
    bodyHtml:
      lines.map((l) => p(escape(l))).join('') +
      p(`<span style="font-family:monospace;font-size:12px" dir="ltr">SHA-256 ${escape(x.sha256)}</span>`),
    bodyText: [...lines, `SHA-256 ${x.sha256}`, x.url],
    cta: { label: m(b, 'mail.idocSigned.cta'), url: x.url },
    reason: reasonOf(m(b, 'mail.reason.automation', { account: b.name })),
  });
};

/** The owner console's channel test (POST /platform/diagnostics/notify). */
export const diagnosticEmail = (x: { to: string; brand: MailBrand }): EmailMessage => {
  const b = x.brand;
  const body = m(b, 'mail.diagnostic.text', { product: b.product });
  const subject = m(b, 'mail.diagnostic.subject', { product: b.product });
  return render(x.to, b, {
    subject,
    title: subject,
    hero: {
      kind: 'bars',
      word: m(b, 'mail.obj.diagnostic.word'),
      detail: `MAIL · OK · ${new Date().toISOString().slice(11, 19)} UTC`,
    },
    bodyHtml: p(escape(body)),
    bodyText: [body],
    reason: reasonOf(m(b, 'mail.reason.diagnostic', { email: x.to, product: b.product })),
  });
};

/** What a notification email needs; names are resolved by the worker at send time. */
export type NotificationMail = {
  type: string;
  actorName: string | null;
  itemName: string | null;
  boardName: string | null;
  columnTitle: string | null;
  excerpt: string | null;
  /** Opens the item (on its updates / time tab). */
  url: string;
};

/** Notifications and the digest: the member of {account} + a link to their notification settings. */
const settingsReason = (b: MailBrand, accountName: string, settingsUrl: string): Reason => ({
  html: `${mh(b, 'mail.settingsFooter', { account: accountName })} <a class="bos-muted" href="${escape(settingsUrl)}" target="_blank" style="color:${C.muted};text-decoration:underline">${escape(m(b, 'mail.settingsLink'))}</a>`,
  text: `${m(b, 'mail.settingsFooter', { account: accountName })}\n${m(b, 'mail.settingsLink')}: ${settingsUrl}`,
});

const sentenceOf = (b: MailBrand, n: NotificationMail) =>
  notificationSentence({ type: n.type, actor: n.actorName, item: n.itemName, column: n.columnTitle }, b.locale);

/** One notification (07 §9.3 / 08 §12.3): the bell's sentence as the subject, the excerpt, a link to the item. */
export const notificationEmail = (x: {
  to: string;
  brand: MailBrand;
  accountName: string;
  settingsUrl: string;
  n: NotificationMail;
}): EmailMessage => {
  const b = x.brand;
  const sentence = sentenceOf(b, x.n);
  const crumb = [x.n.boardName, x.n.itemName].filter(Boolean).join(' › ');
  const hero: Hero | undefined =
    x.n.excerpt && x.n.actorName
      ? { kind: 'bubble', quote: x.n.excerpt, ...(crumb ? { crumb } : {}), who: { name: x.n.actorName, line: '' } }
      : x.n.itemName
        ? { kind: 'row', name: x.n.itemName, ...(x.n.boardName ? { meta: x.n.boardName } : {}) }
        : undefined;
  const objects = b.style === 'objects' && !!hero;
  return render(x.to, b, {
    subject: sentence,
    title: sentence,
    ...(hero ? { hero } : {}),
    bodyHtml: objects
      ? hero.kind === 'row' && x.n.excerpt
        ? quote(x.n.excerpt)
        : ''
      : (x.n.boardName
          ? `<p class="bos-muted" style="margin:0 0 14px;color:${C.muted};font-size:13px">${escape(x.n.boardName)}</p>`
          : '') + (x.n.excerpt ? quote(x.n.excerpt) : ''),
    bodyText: [x.n.boardName, x.n.excerpt],
    cta: { label: m(b, 'mail.openItem'), url: x.n.url },
    reason: settingsReason(b, x.accountName, x.settingsUrl),
  });
};

/** The daily digest: everything still unread, newest first. */
export const digestEmail = (x: {
  to: string;
  brand: MailBrand;
  accountName: string;
  settingsUrl: string;
  /** Opens the account (the bell lists them all). */
  url: string;
  items: NotificationMail[];
  /** The account's time zone (the newspaper's date; default UTC). */
  timeZone?: string;
  /** Show the Hebrew date next to the civil one (the account's calendar setting; Hebrew emails only). */
  hebrewDate?: boolean;
  /** Today (tests). */
  now?: Date;
}): EmailMessage => {
  const b = x.brand;
  const title = m(b, 'mail.digest.title', { n: x.items.length, account: x.accountName });
  const link = linkColor(b.accent);
  const objects = b.style === 'objects';
  const [first, ...more] = x.items;
  const now = x.now ?? new Date();
  const tz = x.timeZone || 'UTC';
  let civil: string;
  let iso: string;
  try {
    civil = new Intl.DateTimeFormat(b.locale === 'he' ? 'he-IL' : 'en-GB', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(now);
    iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      now,
    );
  } catch {
    civil = now.toISOString().slice(0, 10);
    iso = civil;
  }
  const edition = [
    x.accountName,
    b.locale === 'he' && x.hebrewDate !== false
      ? `${civil} · ${formatHebrewDate(iso as IsoDate, 'full', 'he')}`
      : civil,
  ];
  const hero: Hero = {
    kind: 'paper',
    masthead: m(b, 'mail.obj.digest.masthead'),
    edition,
    ...(first
      ? {
          lead: {
            kicker: first.boardName ?? x.accountName,
            head: sentenceOf(b, first),
            ...(first.excerpt ? { dek: first.excerpt } : {}),
            url: first.url,
          },
        }
      : {}),
    numbers: [
      { n: x.items.length, label: m(b, 'mail.obj.digest.unread') },
      { n: x.items.filter((n) => n.type === 'mention').length, label: m(b, 'mail.obj.digest.mentions') },
      { n: new Set(x.items.map((n) => n.boardName).filter(Boolean)).size, label: m(b, 'mail.obj.digest.boards') },
    ],
  };
  const rows = (objects ? more : x.items)
    .map((n) => {
      const excerpt = n.excerpt
        ? `<br><span class="bos-muted" style="color:${C.muted};font-size:14px">${escape(n.excerpt)}</span>`
        : '';
      return `<li class="bos-line" style="margin:0;padding:14px 0;border-bottom:1px solid ${C.line}"><a class="bos-link" href="${escape(n.url)}" target="_blank" style="color:${link};font-weight:600;text-decoration:none">${escape(sentenceOf(b, n))}</a>${excerpt}</li>`;
    })
    .join('');
  return render(x.to, b, {
    subject: title,
    title,
    hero,
    bodyHtml: rows ? `<ul style="margin:4px 0 14px;padding:0;list-style:none">${rows}</ul>` : '',
    bodyText: x.items.map((n) => `• ${sentenceOf(b, n)}${n.excerpt ? `\n  ${n.excerpt}` : ''}\n  ${n.url}`),
    cta: { label: m(b, 'mail.digest.cta', { product: b.product }), url: x.url },
    reason: settingsReason(b, x.accountName, x.settingsUrl),
  });
};

/**
 * An automation's `send_email` (04 §4.2): the subject and body the recipe rendered (item values already
 * HTML-escaped by the template engine), in the standard layout with a link to the item.
 */
export const automationEmail = (x: {
  to: string;
  brand: MailBrand;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  url: string;
  automationTitle: string;
  /** The recipe's Reply-To (else the account's). */
  replyTo?: string;
}): EmailMessage => {
  const b = x.replyTo ? { ...x.brand, replyTo: x.replyTo } : x.brand;
  return render(x.to, b, {
    subject: x.subject,
    title: x.subject,
    hero: { kind: 'letterhead' },
    bodyHtml: `<div style="margin:0 0 14px;white-space:pre-wrap">${x.bodyHtml}</div>`,
    bodyText: [x.bodyText],
    ...(x.url ? { cta: { label: m(b, 'mail.openItem'), url: x.url } } : {}),
    reason: reasonOf(
      `${m(b, 'mail.reason.automation', { account: b.name })} ${m(b, 'mail.automation.footer', { title: x.automationTitle })}`,
    ),
  });
};

/**
 * A reply to someone who emailed an item: the text as written, answering their message (threaded by
 * its Message-ID). The Reply-To is the item's own address, so their answer comes back to the same item.
 */
export const emailReply = (x: {
  to: string;
  brand: MailBrand;
  subject: string;
  text: string;
  /** The item's inbound address. */
  replyTo: string;
  /** The Message-ID of the message this answers. */
  inReplyTo?: string | null;
}): EmailMessage => {
  const b = { ...x.brand, replyTo: x.replyTo };
  return {
    ...render(x.to, b, {
      subject: x.subject,
      title: b.name,
      hero: { kind: 'letterhead' },
      bodyHtml: `<div style="margin:0 0 14px;white-space:pre-wrap">${escape(x.text)}</div>`,
      bodyText: [x.text],
      reason: reasonOf(m(b, 'mail.reason.reply', { account: b.name })),
    }),
    ...(x.inReplyTo ? { inReplyTo: x.inReplyTo } : {}),
  };
};

/**
 * Where an email loads the account's logo: a public redirect (GET /api/v1/public/email-logo/{account}) to a fresh
 * signed URL, so the image still shows when the email is opened days later. `v` changes with the logo (caches).
 */
export const emailLogoUrl = (appUrl: string, accountId: string, assetId: string) =>
  `${appUrl.replace(/\/$/, '')}/api/v1/public/email-logo/${encodeURIComponent(accountId)}?v=${encodeURIComponent(assetId)}`;

/* ---------- preview & test (Administration → Emails & SMS) ---------- */

/**
 * Any email with sample data in the brand's language (the preview and the "send me a test" of the admin page).
 * The sample names come from i18n, so the preview reads like a real email in either language.
 */
export const sampleEmail = (
  key: MailTemplateKey,
  x: { to: string; brand: MailBrand; appUrl: string; accountName: string },
): EmailMessage => {
  const b = x.brand;
  const base = x.appUrl.replace(/\/$/, '');
  const s = (k: string) => m(b, `mail.sample.${k}`);
  const n = (over: Partial<NotificationMail> = {}): NotificationMail => ({
    type: 'mention',
    actorName: s('actor'),
    itemName: s('item'),
    boardName: s('board'),
    columnTitle: null,
    excerpt: s('excerpt'),
    url: `${base}/`,
    ...over,
  });
  const settingsUrl = `${base}/`;
  switch (key) {
    case 'invitation':
      return invitationEmail({
        to: x.to,
        brand: b,
        accountName: x.accountName,
        inviterName: s('actor'),
        role: 'member',
        url: `${base}/`,
        message: s('message'),
      });
    case 'magic_link':
      return magicLinkEmail({ to: x.to, brand: b, url: `${base}/login` });
    case 'reset_password':
      return resetPasswordEmail({ to: x.to, brand: b, url: `${base}/login` });
    case 'notification':
      return notificationEmail({ to: x.to, brand: b, accountName: x.accountName, settingsUrl, n: n() });
    case 'digest':
      return digestEmail({
        to: x.to,
        brand: b,
        accountName: x.accountName,
        settingsUrl,
        url: `${base}/`,
        items: [n(), n({ type: 'assigned', columnTitle: s('column'), excerpt: null })],
      });
    case 'automation':
      return automationEmail({
        to: x.to,
        brand: b,
        subject: s('subject'),
        bodyHtml: escape(s('body')),
        bodyText: s('body'),
        url: `${base}/`,
        automationTitle: s('automation'),
      });
    case 'diagnostic':
      return diagnosticEmail({ to: x.to, brand: b });
  }
};

/** A test send of any email: marked as a test in the subject. */
export const asTestEmail = (mail: EmailMessage, brand: MailBrand): EmailMessage => ({
  ...mail,
  subject: m(brand, 'mail.test.subject', { subject: mail.subject }),
});
