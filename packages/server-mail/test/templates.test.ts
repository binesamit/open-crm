// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_ACCENT, MAIL_STYLES, MAIL_TEMPLATE_KEYS, t, type MessageKey } from '@bines/shared';
import {
  asTestEmail,
  automationEmail,
  diagnosticEmail,
  digestEmail,
  emailLogoUrl,
  emailSender,
  fromHeader,
  invitationEmail,
  magicLinkEmail,
  mailBrand,
  notificationEmail,
  type NotificationMail,
  noticeEmail,
  onAccent,
  resetPasswordEmail,
  sampleEmail,
} from '../src';

// The classic layout's own checks; the objects style is covered below and in objects.test.ts.
const he = { ...mailBrand({ locale: 'he', account: { name: 'Acme' } }), style: 'classic' as const };
const en = { ...mailBrand({ locale: 'en', account: { name: 'Acme' } }), style: 'classic' as const };
const k = (key: string, vars?: Record<string, string | number>, locale: 'he' | 'en' = 'he') =>
  t(key as MessageKey, vars, locale);

const n = (over: Partial<NotificationMail> = {}): NotificationMail => ({
  type: 'mention',
  actorName: 'דנה',
  itemName: 'הצעת מחיר',
  boardName: 'לידים',
  columnTitle: null,
  excerpt: 'תבדקי בבקשה',
  url: 'https://app.test/a/acme/b/B/i/I?tab=updates',
  ...over,
});

describe('notificationEmail', () => {
  it('uses the bell sentence as the subject and links to the item (RTL)', () => {
    const mail = notificationEmail({
      to: 'a@b.c',
      brand: he,
      accountName: 'Acme',
      settingsUrl: 'https://app.test/a/acme',
      n: n(),
    });
    expect(mail.subject).toBe('דנה תייג/ה אתכם ב־הצעת מחיר');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('href="https://app.test/a/acme/b/B/i/I?tab=updates"');
    expect(mail.html).toContain(k('mail.settingsLink'));
    expect(mail.text).toBe(
      [
        'Acme',
        '',
        'דנה תייג/ה אתכם ב־הצעת מחיר',
        '',
        'לידים',
        'תבדקי בבקשה',
        '',
        `${k('mail.openItem')}: https://app.test/a/acme/b/B/i/I?tab=updates`,
        '',
        '--',
        k('mail.settingsFooter', { account: 'Acme' }),
        `${k('mail.settingsLink')}: https://app.test/a/acme`,
        k('mail.footer.product', { product: he.product }),
      ].join('\n'),
    );
  });

  it('escapes what users typed (names, excerpts)', () => {
    const mail = notificationEmail({
      to: 'a@b.c',
      brand: he,
      accountName: '<Acme>',
      settingsUrl: 'https://app.test',
      n: n({ itemName: '<img src=x onerror=alert(1)>', excerpt: '<script>x</script>' }),
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<Acme>');
  });

  it('assignment names the column; a forgotten timer has no actor', () => {
    const assigned = notificationEmail({
      to: 'a@b.c',
      brand: he,
      accountName: 'Acme',
      settingsUrl: 'https://app.test',
      n: n({ type: 'assigned', columnTitle: 'אחראי', excerpt: null }),
    });
    expect(assigned.subject).toBe('דנה שיבץ/ה אתכם ב־הצעת מחיר (אחראי)');
    const timer = notificationEmail({
      to: 'a@b.c',
      brand: he,
      accountName: 'Acme',
      settingsUrl: 'https://app.test',
      n: n({ type: 'time.forgotten', actorName: null, excerpt: null }),
    });
    expect(timer.subject).toBe('טיימר רץ יותר מ-12 שעות ב־הצעת מחיר — שכחת לעצור?');
  });
});

describe('noticeEmail links', () => {
  it('lists the links under the text (title, note, address), escaped, in HTML and text', () => {
    const mail = noticeEmail({
      to: 'a@b.c',
      brand: en,
      subject: 'Reply',
      title: 'Support replied',
      lines: ['See below'],
      links: {
        title: 'Articles',
        items: [{ label: 'Add a <status> column', url: 'https://app.test/help?article=status', note: 'How & why' }],
      },
      reason: 'You opened a ticket',
    });
    expect(mail.html).toContain('href="https://app.test/help?article=status"');
    expect(mail.html).toContain('Add a &lt;status&gt; column');
    expect(mail.html).toContain('How &amp; why');
    expect(mail.text).toContain('Articles');
    expect(mail.text).toContain('https://app.test/help?article=status');
    const plain = noticeEmail({ to: 'a@b.c', brand: en, subject: 's', title: 't', lines: ['x'], reason: 'r' });
    expect(plain.html).not.toContain('<ul');
  });
});

describe('digestEmail', () => {
  it('lists every unread notification with its link', () => {
    const mail = digestEmail({
      to: 'a@b.c',
      brand: he,
      accountName: 'Acme',
      settingsUrl: 'https://app.test/a/acme',
      url: 'https://app.test/a/acme',
      items: [n(), n({ type: 'reply', excerpt: 'עניתי' })],
    });
    expect(mail.subject).toBe(k('mail.digest.title', { n: 2, account: 'Acme' }));
    expect(mail.html.match(/<li /g)).toHaveLength(2);
    expect(mail.text).toContain('דנה הגיב/ה לעדכון שלכם ב־הצעת מחיר\n  עניתי');
  });
});

describe('mail brand (ANSWERS 6א.3)', () => {
  it("an account's email: its sender name (default = its name) and Reply-To", () => {
    expect(he.senderName).toBe('Acme');
    const own = mailBrand({
      locale: 'he',
      account: { name: 'Acme', branding: { email_sender_name: 'Acme Support', email_reply_to: 'help@acme.test' } },
    });
    expect(own).toMatchObject({ senderName: 'Acme Support', replyTo: 'help@acme.test' });
    const mail = notificationEmail({ to: 'a@b.c', brand: own, accountName: 'Acme', settingsUrl: 'https://x', n: n() });
    expect(mail).toMatchObject({ fromName: 'Acme Support', replyTo: 'help@acme.test' });
  });

  it('an email of no account: the platform sender, else the product name (owner console, else i18n app.name)', () => {
    expect(mailBrand({ locale: 'en' }).senderName).toBe(t('app.name', undefined, 'en'));
    const white = mailBrand({ locale: 'en', platform: { product_name: 'WorkHub' } });
    expect(white).toMatchObject({ product: 'WorkHub', senderName: 'WorkHub' });
    expect(
      mailBrand({ locale: 'en', platform: { product_name: 'WorkHub', email: { sender_name: 'Ops' } } }).senderName,
    ).toBe('Ops');
    const magic = magicLinkEmail({ to: 'a@b.c', brand: white, url: 'https://x/login' });
    expect(magic.subject).toBe(k('mail.magic.subject', { product: 'WorkHub' }, 'en'));
    expect(magic.fromName).toBe('WorkHub');
  });

  it("is written in the recipient's language and direction", () => {
    const mail = invitationEmail({
      to: 'a@b.c',
      brand: en,
      accountName: 'Acme',
      inviterName: 'Dana',
      role: 'member',
      url: 'https://x/invite',
    });
    expect(mail.html).toContain('dir="ltr"');
    expect(mail.html).toContain('lang="en"');
    expect(mail.subject).toBe(k('mail.invite.subject', { account: 'Acme', product: en.product }, 'en'));
    const who = k('mail.invite.byWho', { inviter: 'Dana' }, 'en');
    expect(mail.text).toContain(
      k('mail.invite.body', { who, account: 'Acme', role: t('role.member', undefined, 'en') }, 'en'),
    );
    const heMail = invitationEmail({
      ...{ to: 'a@b.c', accountName: 'Acme', inviterName: null, role: 'admin' as const },
      brand: he,
      url: 'https://x',
    });
    expect(heMail.html).toContain('dir="rtl"');
  });

  it('shows the account logo through the public redirect', () => {
    const url = emailLogoUrl('https://app.test/', 'ACC1', 'ASSET1');
    expect(url).toBe('https://app.test/api/v1/public/email-logo/ACC1?v=ASSET1');
    const mail = notificationEmail({
      to: 'a@b.c',
      brand: mailBrand({ locale: 'he', account: { name: 'Acme' }, logoUrl: url }),
      accountName: 'Acme',
      settingsUrl: 'https://x',
      n: n(),
    });
    expect(mail.html).toContain(`<img src="${url}"`);
    expect(
      notificationEmail({ to: 'a@b.c', brand: he, accountName: 'Acme', settingsUrl: 'https://x', n: n() }).html,
    ).not.toContain('<img');
  });
});

describe('emailSender', () => {
  it('the address comes from the env, the name from the message; no literal brand', () => {
    expect(emailSender({ RESEND_FROM: 'office@example.com' })).toEqual({ address: 'office@example.com', name: null });
    expect(fromHeader(emailSender({ RESEND_FROM: 'office@example.com' }), 'Acme')).toBe('"Acme" <office@example.com>');
    expect(emailSender({ EMAIL_FROM: 'X <x@y.z>', RESEND_FROM: 'a@b.c' })).toEqual({ address: 'x@y.z', name: 'X' });
  });

  it('Resend without a sending address refuses (logged), never a made-up one', async () => {
    const { createMailer } = await import('../src/mailer');
    const errors: string[] = [];
    const mailer = createMailer({ RESEND_API_KEY: 'k' }, { error: (_o, m) => errors.push(m) });
    await expect(mailer.send({ to: 'b@y.com', subject: 's', html: '', text: '' })).rejects.toThrow(
      'email_from_not_configured',
    );
    expect(errors[0]).toMatch(/EMAIL_FROM/);
  });
});

describe('MAIL_ALLOWLIST (staging)', () => {
  it('matches addresses and @domains, case-insensitively', async () => {
    const { mailAllowed } = await import('../src/mailer');
    expect(mailAllowed('dana@x.com, @team.io', 'Dana@X.com')).toBe(true);
    expect(mailAllowed('amit@x.com, @team.io', 'dana@team.io')).toBe(true);
    expect(mailAllowed('amit@x.com, @team.io', 'someone@other.com')).toBe(false);
  });
  it('skips (and logs) mail to anyone else', async () => {
    const { createMailer } = await import('../src/mailer');
    const errors: string[] = [];
    const mailer = createMailer({ MAIL_ALLOWLIST: 'a@x.com' }, { error: (_o, m) => errors.push(m) });
    await mailer.send({ to: 'b@y.com', subject: 's', html: '', text: '' });
    expect(errors[0]).toMatch(/MAIL_ALLOWLIST/);
  });
});

/* ---------- M11: one branded layout for every email ---------- */

const htmlAttr = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

describe('every template, in Hebrew and English, in both styles (M11)', () => {
  for (const style of MAIL_STYLES)
    for (const key of MAIL_TEMPLATE_KEYS)
      for (const locale of ['he', 'en'] as const) {
        it(`${key} (${locale}, ${style}): direction, header, footer, plain text, client-safe markup`, () => {
          const b = { ...(locale === 'he' ? he : en), style };
          const mail = sampleEmail(key, {
            to: 'dana@acme.test',
            brand: b,
            appUrl: 'https://app.test/',
            accountName: 'Acme',
          });
          expect(mail.to).toBe('dana@acme.test');
          expect(mail.subject.length).toBeGreaterThan(0);
          expect(mail.fromName).toBe('Acme');
          // Direction and language follow the recipient.
          expect(mail.html).toContain(`<html dir="${locale === 'he' ? 'rtl' : 'ltr'}" lang="${locale}">`);
          expect(mail.html).toContain(`text-align:${locale === 'he' ? 'right' : 'left'}`);
          // Header: the account's name; the brand colour (monogram / button).
          expect(mail.html).toContain('>Acme</td>');
          expect(mail.html).toContain(`background-color:${b.accent}`);
          // Footer: the product line (owner console product name).
          expect(mail.html).toContain(htmlAttr(k('mail.footer.product', { product: b.product }, locale)));
          // Major clients: tables + inline styles, no external CSS, no scripts, dark-mode hints.
          expect(mail.html).toMatch(/^<!doctype html>/);
          expect(mail.html).toContain('role="presentation"');
          expect(mail.html).not.toMatch(/<link|<script|@import|url\(/i);
          expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
          expect(mail.html).toContain('prefers-color-scheme:dark');
          // Plain-text part: header, footer, no markup.
          expect(mail.text.startsWith('Acme\n')).toBe(true);
          expect(mail.text).toContain(k('mail.footer.product', { product: b.product }, locale));
          expect(mail.text).not.toMatch(/<[a-z][^>]*>/i);
        });
      }

  it('explains why the recipient got each email', () => {
    const invite = sampleEmail('invitation', { to: 'x@y.z', brand: en, appUrl: 'https://a', accountName: 'Acme' });
    expect(invite.text).toContain(k('mail.reason.invite', { email: 'x@y.z', account: 'Acme' }, 'en'));
    const reset = resetPasswordEmail({ to: 'x@y.z', brand: en, url: 'https://a/login' });
    expect(reset.text).toContain(k('mail.reason.reset', { email: 'x@y.z', product: en.product }, 'en'));
    expect(reset.text).toContain(k('mail.footer.ignore', undefined, 'en'));
    const diag = diagnosticEmail({ to: 'x@y.z', brand: he });
    expect(diag.text).toContain(k('mail.reason.diagnostic', { email: 'x@y.z', product: he.product }));
    const auto = automationEmail({
      to: 'x@y.z',
      brand: he,
      subject: 's',
      bodyHtml: 'b',
      bodyText: 'b',
      url: 'https://a/i',
      automationTitle: 'Flow',
    });
    expect(auto.text).toContain(k('mail.automation.footer', { title: 'Flow' }));
    expect(auto.text).toContain(k('mail.reason.automation', { account: 'Acme' }));
  });

  it('a test send is marked in the subject', () => {
    const mail = sampleEmail('magic_link', { to: 'x@y.z', brand: en, appUrl: 'https://a', accountName: 'Acme' });
    expect(asTestEmail(mail, en).subject).toBe(k('mail.test.subject', { subject: mail.subject }, 'en'));
  });
});

describe('accent colour (M11)', () => {
  it("the account's, else the owner's, else the platform's colour; never anything but #rrggbb", () => {
    expect(mailBrand({ locale: 'he', account: { name: 'A' } }).accent).toBe(DEFAULT_EMAIL_ACCENT);
    const platform = { email: { accent_color: '#AA0000' } };
    expect(mailBrand({ locale: 'he', platform, account: { name: 'A' } }).accent).toBe('#aa0000');
    expect(mailBrand({ locale: 'he', platform }).accent).toBe('#aa0000');
    const own = mailBrand({
      locale: 'he',
      platform,
      account: { name: 'A', branding: { email_accent_color: '#123456' } },
    });
    expect(own.accent).toBe('#123456');
    const evil = mailBrand({
      locale: 'he',
      account: { name: 'A', branding: { email_accent_color: 'red;background:url(https://x)' } },
    });
    expect(evil.accent).toBe(DEFAULT_EMAIL_ACCENT);
  });

  it('the button text reads on any accent', () => {
    expect(onAccent('#0d3b35')).toBe('#ffffff');
    expect(onAccent('#ffd400')).toBe('#1e1f22');
    const light = mailBrand({
      locale: 'en',
      account: { name: 'A', branding: { email_accent_color: '#ffd400', email_style: 'classic' } },
    });
    const mail = magicLinkEmail({ to: 'a@b.c', brand: light, url: 'https://x' });
    expect(mail.html).toContain('color:#1e1f22;text-decoration:none');
  });

  it('the button has a plain-link fallback, and a dark accent turns light in dark mode', () => {
    const mail = magicLinkEmail({ to: 'a@b.c', brand: en, url: 'https://x/login?t="1"' });
    expect(mail.html.split('href="https://x/login?t=&quot;1&quot;"')).toHaveLength(3);
    expect(mail.html).toContain('>https://x/login?t=&quot;1&quot;</a>');
    expect(mail.html).toContain(k('mail.linkFallback', undefined, 'en'));
    // The default green would vanish on the dark card; a light accent stays as it is.
    expect(mail.html).toMatch(/\.bos-acc\{background-color:#f2f8f6!important;color:#0d3b35!important\}/);
    const light = mailBrand({
      locale: 'en',
      account: { name: 'A', branding: { email_accent_color: '#ffb020', email_style: 'classic' } },
    });
    expect(magicLinkEmail({ to: 'a@b.c', brand: light, url: 'https://x' }).html).not.toContain('.bos-acc{');
  });
});

describe('logo and escaping (M11)', () => {
  it('the logo URL is attribute-escaped and sits on its own light chip (dark mode)', () => {
    const url = emailLogoUrl('https://app.test', 'ACC 1', 'A&B');
    expect(url).toBe('https://app.test/api/v1/public/email-logo/ACC%201?v=A%26B');
    const b = mailBrand({
      locale: 'en',
      account: { name: 'Acme' },
      logoUrl: 'https://x/l.png?a=1&b="2"',
      platform: { email: { style: 'classic' } },
    });
    const mail = magicLinkEmail({ to: 'a@b.c', brand: b, url: 'https://x' });
    expect(mail.html).toContain('<img src="https://x/l.png?a=1&amp;b=&quot;2&quot;" alt="Acme"');
    expect(mail.html).toContain('bgcolor="#ffffff"');
  });

  it('names people typed never become HTML (account, inviter, sender, message, automation title)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const b = mailBrand({ locale: 'he', account: { name: evil, branding: { email_sender_name: 'Acme' } } });
    const invite = invitationEmail({
      to: 'a@b.c',
      brand: b,
      accountName: evil,
      inviterName: evil,
      role: 'member',
      url: 'https://x/"><script>',
      message: `${evil}<script>alert(1)</script>`,
    });
    const auto = automationEmail({
      to: 'a@b.c',
      brand: b,
      subject: evil,
      bodyHtml: htmlAttr(evil),
      bodyText: evil,
      url: 'https://x',
      automationTitle: evil,
    });
    for (const mail of [invite, auto]) {
      expect(mail.html).not.toContain('<img src=x');
      expect(mail.html).not.toContain('<script');
      expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
    expect(invite.html).toContain('href="https://x/&quot;&gt;&lt;script&gt;"');
    // The plain-text part keeps what was typed, verbatim (it is never rendered as HTML).
    expect(invite.text).toContain(evil);
  });
});
