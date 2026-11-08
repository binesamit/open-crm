// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAIL_STYLE } from '@bines/shared';
import {
  deviceOf,
  digestEmail,
  type Hero,
  invitationEmail,
  magicLinkEmail,
  mailBrand,
  noticeEmail,
  notificationEmail,
} from '../src';

/** The objects style (canvas 2026-11-04): each email's picture, email-safe, every value escaped. */
const he = { ...mailBrand({ locale: 'he', account: { name: 'Acme' } }), style: 'objects' as const };
const en = { ...mailBrand({ locale: 'en', account: { name: 'Acme' } }), style: 'objects' as const };
const EVIL = '<img src=x onerror=alert(1)>';

const HEROES: Hero[] = [
  { kind: 'key', minutes: 10, minutesLabel: EVIL, sub: EVIL, email: EVIL, context: [[EVIL, EVIL]] },
  { kind: 'dial', label: EVIL },
  { kind: 'metro', stations: [EVIL, EVIL, EVIL], current: 1, here: EVIL },
  { kind: 'sign', word: EVIL, sub: EVIL },
  { kind: 'state', tone: 'no', glyph: EVIL },
  {
    kind: 'seats',
    people: [{ initial: '<', color: '#e2551f' }],
    me: EVIL,
    caption: EVIL,
    note: { text: EVIL, by: EVIL },
    days: { total: 7, label: EVIL },
  },
  { kind: 'poster', badge: EVIL },
  { kind: 'bubble', quote: EVIL, crumb: EVIL, who: { name: EVIL, line: EVIL } },
  { kind: 'row', name: EVIL, meta: EVIL, crumb: EVIL },
  {
    kind: 'paper',
    masthead: EVIL,
    edition: [EVIL],
    lead: { kicker: EVIL, head: EVIL, dek: EVIL, url: 'https://a/"x' },
    numbers: [{ n: 1, label: EVIL }],
  },
  { kind: 'letterhead' },
  { kind: 'bars', word: EVIL, detail: EVIL },
  { kind: 'tag', numberLabel: EVIL, number: '1042', subject: EVIL, fields: [[EVIL, EVIL]] },
  { kind: 'thread', who: EVIL },
  { kind: 'flaps', head: EVIL, rows: [{ label: EVIL, value: EVIL, accent: true }] },
  { kind: 'seal', letter: EVIL },
  { kind: 'count', n: EVIL, unit: EVIL, tone: 'bad' },
  { kind: 'ticket', caption: EVIL, name: EVIL, stub: EVIL, stamp: EVIL, fields: [[EVIL, EVIL]] },
  { kind: 'card', stamp: EVIL, last4: EVIL },
  { kind: 'calendar', n: 5, head: EVIL, unit: EVIL },
  { kind: 'vitrine', label: EVIL },
  { kind: 'days', big: EVIL, done: 2, total: 30, caption: EVIL },
  { kind: 'fade' },
  { kind: 'crate', caption: EVIL, name: EVIL, fields: [[EVIL, EVIL]], formats: [EVIL], stamp: EVIL },
  { kind: 'code', caption: EVIL, code: 'AB-<x>', meta: [EVIL, EVIL] },
];

describe('the objects style', () => {
  it('is the default look; the account chooses over the owner', () => {
    expect(DEFAULT_MAIL_STYLE).toBe('objects');
    expect(mailBrand({ locale: 'he' }).style).toBe('objects');
    expect(mailBrand({ locale: 'he', platform: { email: { style: 'classic' } } }).style).toBe('classic');
    expect(
      mailBrand({
        locale: 'he',
        platform: { email: { style: 'classic' } },
        account: { name: 'A', branding: { email_style: 'objects' } },
      }).style,
    ).toBe('objects');
  });

  for (const hero of HEROES)
    it(`${hero.kind}: email-safe markup, every value escaped, both directions`, () => {
      for (const brand of [he, en]) {
        const mail = noticeEmail({
          to: 'x@y.z',
          brand,
          subject: EVIL,
          title: EVIL,
          lines: [EVIL],
          hero,
          cta: { label: EVIL, url: 'https://a/b' },
          reason: EVIL,
        });
        expect(mail.html).not.toContain('<img src=x');
        expect(mail.html).not.toContain('"x"');
        expect(mail.html).not.toMatch(/<link|<script|@import|url\(|position:\s*(absolute|fixed)/i);
        expect(mail.html).toContain('role="presentation"');
        expect(mail.html).toContain(`<html dir="${brand === he ? 'rtl' : 'ltr'}"`);
      }
    });

  it('the classic layout ignores the picture', () => {
    const classic = { ...he, style: 'classic' as const };
    const mail = noticeEmail({
      to: 'x@y.z',
      brand: classic,
      subject: 's',
      title: 't',
      lines: ['l'],
      hero: { kind: 'tag', numberLabel: 'n', number: '1042', subject: 'zz-subject', fields: [] },
      reason: 'r',
    });
    expect(mail.html).not.toContain('zz-subject');
  });

  it('sign-in: a key-card with the button on it and who asked', () => {
    const mail = magicLinkEmail({
      to: 'dana@acme.test',
      brand: he,
      url: 'https://a/login',
      context: { device: 'Chrome · Windows' },
    });
    expect(mail.html).toContain('Chrome · Windows');
    // The card's button + the copy-the-link line.
    expect(mail.html.match(/href="https:\/\/a\/login"/g)?.length).toBe(2);
  });

  it('invitation: the team seats and the inviter note', () => {
    const mail = invitationEmail({
      to: 'n@a.test',
      brand: he,
      accountName: 'Acme',
      inviterName: 'Dana',
      role: 'member',
      url: 'https://a/i',
      message: 'Welcome!',
      team: ['Dana', 'Yossi'],
    });
    expect(mail.html).toMatch(/>D<\/td>/);
    expect(mail.html).toMatch(/>Y<\/td>/);
    expect(mail.html).toContain('Welcome!');
  });

  it('notification: a mention is a speech bubble with the excerpt', () => {
    const mail = notificationEmail({
      to: 'a@b.c',
      brand: he,
      accountName: 'Acme',
      settingsUrl: 'https://a/s',
      n: {
        type: 'mention',
        actorName: 'Dana',
        itemName: 'Quote',
        boardName: 'Leads',
        columnTitle: null,
        excerpt: 'Can you check?',
        url: 'https://a/i',
      },
    });
    expect(mail.html).toContain('Can you check?');
    expect(mail.html).toContain('Leads › Quote');
  });

  it('digest: a newspaper with the lead story, the Hebrew date and the numbers', () => {
    const n = {
      type: 'mention',
      actorName: 'Dana',
      itemName: 'Quote',
      boardName: 'Leads',
      columnTitle: null,
      excerpt: null,
      url: 'https://a/1',
    };
    const mail = digestEmail({
      to: 'a@b.c',
      brand: he,
      accountName: 'Acme',
      settingsUrl: 'https://a/s',
      url: 'https://a/',
      items: [n, { ...n, type: 'assigned', url: 'https://a/2' }],
      timeZone: 'Asia/Jerusalem',
      now: new Date('2026-11-04T09:00:00Z'),
    });
    expect(mail.html).toContain('תשפ״ז');
    // The lead story is not repeated in the list below it.
    expect(mail.html.match(/href="https:\/\/a\/1"/g)?.length).toBe(1);
    expect(mail.html.match(/href="https:\/\/a\/2"/g)?.length).toBe(1);
  });

  it('the device line from a User-Agent', () => {
    expect(
      deviceOf(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      ),
    ).toBe('Chrome · Windows');
    expect(
      deviceOf(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iOS');
    expect(deviceOf(null)).toBeNull();
    expect(deviceOf('curl/8.0')).toBeNull();
  });
});
