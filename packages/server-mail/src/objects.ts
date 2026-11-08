// SPDX-License-Identifier: AGPL-3.0-only
import { C, DISPLAY, FONT, MONO, S, SERIF, escapeHtml as e, linkColor, mix, onAccent } from './palette';

/**
 * The "objects" style of the emails (canvas 2026-11-04, artifact FMNJHBWi): every email gets one picture that tells
 * what happened before a word is read — a key-card for a sign-in link, a luggage tag for a support ticket, a
 * newspaper for the digest. Everything here is email-safe: nested tables, inline styles, `bgcolor` fallbacks, no
 * images, no positioning. Clients without rounded corners (Outlook for Windows) get the same blocks, square.
 * Every value that reaches HTML is escaped here; callers pass plain text.
 */
export type Hero =
  /** Sign-in link: a key-card with the title inside, a countdown ring and the button on the card. */
  | { kind: 'key'; minutes: number; minutesLabel: string; sub: string; email: string; context?: [string, string][] }
  /** Password reset: a safe's dial next to the title. */
  | { kind: 'dial'; label: string }
  /** Sign-up verification: a three-station line, the current one marked. */
  | { kind: 'metro'; stations: [string, string, string]; current: 0 | 1 | 2; here: string }
  /** Account approved: a shop sign. */
  | { kind: 'sign'; word: string; sub: string }
  /** A small state badge (pending, exists, rejected…). */
  | { kind: 'state'; tone: 'wait' | 'ok' | 'no'; glyph: string }
  /** Invitation: the team's seats with one empty seat for the recipient, the inviter's note, the days left. */
  | {
      kind: 'seats';
      people: { initial: string; color: string }[];
      me: string;
      caption?: string;
      note?: { text: string; by?: string };
      days?: { total: number; label: string };
    }
  /** Welcome: a poster in the accent with the title inside. */
  | { kind: 'poster'; badge?: string }
  /** A mention / reply: the excerpt as a speech bubble, the sentence beside the avatar. */
  | { kind: 'bubble'; quote: string; crumb?: string; who: { name: string; line: string } }
  /** Any other notification: the item as a board row. */
  | { kind: 'row'; name: string; meta?: string; crumb?: string }
  /** The digest: a newspaper masthead, the lead story and the numbers. */
  | {
      kind: 'paper';
      masthead: string;
      edition: string[];
      lead?: { kicker: string; head: string; dek?: string; url: string };
      numbers: { n: number; label: string }[];
    }
  /** An account's own voice (automations, documents, replies): letterhead with the accent band. */
  | { kind: 'letterhead' }
  /** The channel test: colour bars and an "on air" plate. */
  | { kind: 'bars'; word: string; detail: string }
  /** A support ticket: a luggage tag with the number. */
  | { kind: 'tag'; numberLabel: string; number: string; subject: string; fields: [string, string][] }
  /** A support reply: the answer as a chat bubble (the lines). */
  | { kind: 'thread'; who: string; when?: string }
  /** A status change: a split-flap board. */
  | { kind: 'flaps'; head: string; rows: { label: string; value: string; accent?: boolean; ltr?: boolean }[] }
  /** Security notices: a wax-sealed envelope, and the access window when there is one. */
  | { kind: 'seal'; letter: string; window?: { start: string; end: string; now?: string; pct: number } }
  /** A count that is the news (errors, hours left). */
  | { kind: 'count'; n: string; unit: string; tone: 'bad' | 'accent' }
  /** A plan that is paid: a ticket with a stub and a stamp. */
  | { kind: 'ticket'; caption: string; name: string; stub: string; stamp: string; fields: [string, string][] }
  /** A payment that failed: a card with a stamp. */
  | { kind: 'card'; stamp: string; last4?: string; steps?: string[] }
  /** Days left: a tear-off calendar. */
  | { kind: 'calendar'; n: number; head: string; unit: string }
  /** Read only: a board behind glass with a lock. */
  | { kind: 'vitrine'; label: string }
  /** A deletion date: one square per day. */
  | { kind: 'days'; big: string; done: number; total: number; caption: string }
  /** The last email: lines that fade out (no accent). */
  | { kind: 'fade' }
  /** An export: a shipping crate label. */
  | { kind: 'crate'; caption: string; name: string; fields: [string, string][]; formats: string[]; stamp: string }
  /** A licence key: a dark card with the key in segments. */
  | { kind: 'code'; caption: string; code: string; meta: [string, string] };

/** Where a hero sits and what it replaces in the layout. */
export const heroInfo = (h: Hero | undefined) => {
  const k = h?.kind;
  return {
    /** The hero shows the title itself (the layout skips its heading). */
    ownsTitle:
      k === 'key' || k === 'dial' || k === 'poster' || k === 'bubble' || k === 'paper' || k === 'fade' || k === 'code',
    /** The hero holds the button (the layout keeps only the copy-the-link line). */
    ownsCta: k === 'key',
    /** The hero comes before the heading (a picture that sets the scene). */
    first: k === 'sign' || k === 'state' || k === 'bars' || k === 'seal' || k === 'card' || k === 'calendar',
    /** No brand row: the hero carries the name. */
    noBrand: k === 'poster',
    /** The account's letterhead (a band in the accent along the card). */
    band: k === 'letterhead',
    /** No accent anywhere (the farewell). */
    muted: k === 'fade',
  };
};

export type HeroCtx = {
  accent: string;
  start: 'left' | 'right';
  end: 'left' | 'right';
  dir: 'rtl' | 'ltr';
  title: string;
  cta?: { label: string; url: string };
};

const T = (inner: string, attrs = '') =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${attrs}>${inner}</table>`;
const FULL = ' width="100%"';
/** A row of the card, padded like the rest of it. */
const row = (inner: string, pad = '24px 34px 0') => `<tr><td class="bos-pad" style="padding:${pad}">${inner}</td></tr>`;
/** A display size that keeps the longest word inside the card (clients without the display face use Heebo). */
const fit = (text: string, big: number) => {
  const longest = Math.max(...text.split(/\s+/).map((w) => Array.from(w).length), 1);
  const chars = Array.from(text).length;
  if (chars <= 8 && longest <= 8) return big;
  if (chars <= 16 && longest <= 10) return Math.round(big * 0.66);
  return Math.round(big * 0.42);
};
const face = (start: string) => `font-family:${FONT};text-align:${start}`;
const disp = (size: number, color: string, extra = '') =>
  `font-family:${DISPLAY};font-weight:400;font-size:${size}px;line-height:.9;color:${color};${extra}`;
/** A circle of `size` px (a cell with a 50% radius). */
const circle = (size: number, style: string, inner: string, cls = '') =>
  T(
    `<tr><td${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" align="center" valign="middle" style="width:${size}px;height:${size}px;border-radius:50%;text-align:center;${style}">${inner}</td></tr>`,
  );
/** A deterministic colour for a person's initial (the app's avatar colours). */
const AVATARS = ['#e2551f', '#2b7a6f', '#5b3fd9', '#c38a12', '#2346d8', '#a3195b', '#1f8a5b'];
export const avatarColor = (name: string) =>
  AVATARS[Array.from(name).reduce((s, ch) => s + ch.codePointAt(0)!, 0) % AVATARS.length]!;
export const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? '';

const pill = (label: string, url: string, bg: string, fg: string) =>
  T(
    `<tr><td class="bos-acc" bgcolor="${bg}" style="background-color:${bg};border-radius:999px;mso-padding-alt:12px 24px"><a class="bos-acc" href="${e(url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:500;line-height:20px;color:${fg};text-decoration:none;border-radius:999px">${e(label)}</a></td></tr>`,
  );
export const ctaPill = (label: string, url: string, accent: string) => pill(label, url, accent, onAccent(accent));

const kv = (fields: [string, string][], key: string, val: string, start: string) =>
  T(
    fields
      .map(
        ([k, v]) =>
          `<tr><td style="${face(start)};font-size:12.5px;line-height:1.7;color:${key};padding-${start === 'right' ? 'left' : 'right'}:16px;white-space:nowrap">${e(k)}</td><td style="${face(start)};font-size:13.5px;line-height:1.7;color:${val}">${e(v)}</td></tr>`,
      )
      .join(''),
  );

/** A decorative barcode: thin cells, on and off. */
const barcode = (color: string, height = 34) => {
  const widths = [2, 1, 3, 1, 1, 2, 4, 1, 2, 2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 4, 1, 2, 3, 1, 1, 2, 2, 1, 3, 1, 2, 1];
  const cells = widths
    .map(
      (w, i) =>
        `<td width="${w * 2}" style="width:${w * 2}px;height:${height}px;${i % 2 ? '' : `background-color:${color}`}"></td>`,
    )
    .join('');
  return T(`<tr>${cells}</tr>`, ' dir="ltr"');
};

/* ---------- the objects ---------- */

export const renderHero = (h: Hero, x: HeroCtx): string => {
  const acc = x.accent;
  const on = onAccent(acc);
  const soft = mix(acc, '#ffffff', 0.1);
  const mid = mix(acc, '#ffffff', 0.35);
  const accText = linkColor(acc);
  const f = face(x.start);
  switch (h.kind) {
    case 'key': {
      const ring = circle(
        96,
        `border:7px solid ${on}`,
        `<div style="${disp(44, on)}">${h.minutes}</div><div style="font-family:${FONT};font-size:11px;line-height:1.2;color:${on}">${e(h.minutesLabel)}</div>`,
      );
      const card = T(
        `<tr><td align="center" style="padding:16px 0 0"><div style="width:58px;height:12px;border-radius:8px;background-color:${C.page};font-size:0;line-height:0">&nbsp;</div></td></tr>
<tr><td style="padding:14px 30px 0">${T(`<tr><td valign="bottom" style="${f}"><div style="${disp(fit(x.title, 88), on)}">${e(x.title)}</div><div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${on};padding-top:6px">${e(h.sub)}</div></td><td width="112" align="${x.end}" valign="middle">${ring}</td></tr>`, FULL)}</td></tr>
<tr><td style="padding:20px 0 0"><div style="height:28px;background-color:${mix('#000000', acc, 0.3)};font-size:0;line-height:0">&nbsp;</div></td></tr>
<tr><td style="padding:20px 30px 24px">${T(`<tr><td>${x.cta ? pill(x.cta.label, x.cta.url, on, acc) : ''}</td><td align="${x.end}" dir="ltr" style="font-family:${MONO};font-size:12px;color:${on}">${e(h.email)}</td></tr>`, FULL)}</td></tr>`,
        ` width="100%" class="bos-acc" bgcolor="${acc}" style="background-color:${acc};border-radius:24px"`,
      );
      const ctx = h.context?.length
        ? T(
            `<tr>${h.context.map(([k, v]) => `<td valign="top" class="bos-muted" style="${f};font-size:12px;line-height:1.5;color:${C.muted};padding-top:14px">${e(k)}<br><span class="bos-ink" style="font-size:13.5px;color:${C.ink}">${e(v)}</span></td>`).join('')}</tr>`,
            FULL,
          )
        : '';
      return row(card + ctx, '28px 34px 0');
    }
    case 'dial': {
      const knob = circle(118, `background-color:${acc};${disp(40, on)}`, e(h.label), 'bos-acc');
      const dial = circle(166, `border:3px dotted ${C.ink};padding:0`, knob);
      return row(
        T(
          `<tr><td width="180" valign="middle">${dial}</td><td valign="middle" class="bos-head" style="${f};padding-${x.start}:22px;${disp(fit(x.title, 60), C.heading)}">${e(x.title)}</td></tr>`,
          FULL,
        ),
        '26px 34px 0',
      );
    }
    case 'metro': {
      const station = (i: number, label: string) => {
        const done = i < h.current;
        const now = i === h.current;
        const dot = circle(
          26,
          done
            ? `background-color:${acc};border:4px solid ${acc}`
            : now
              ? `background-color:${C.card};border:4px solid ${acc};box-shadow:0 0 0 7px ${soft}`
              : `background-color:${C.card};border:4px solid ${C.line}`,
          '&nbsp;',
        );
        const here = now
          ? `<div style="padding-top:4px"><span style="font-family:${FONT};font-size:11px;background-color:${acc};color:${on};border-radius:999px;padding:1px 8px">${e(h.here)}</span></div>`
          : '';
        return `<td width="30%" align="center" valign="top" style="text-align:center"><div align="center">${dot}</div><div class="${now ? 'bos-ink' : 'bos-muted'}" style="font-family:${FONT};font-size:13px;line-height:1.4;padding-top:8px;color:${now ? C.ink : C.muted}">${e(label)}</div>${here}</td>`;
      };
      const link = (lit: boolean) =>
        `<td width="5%" valign="top" style="padding-top:15px"><div style="height:4px;border-radius:4px;background-color:${lit ? acc : C.line};font-size:0;line-height:0">&nbsp;</div></td>`;
      return row(
        T(
          `<tr>${station(0, h.stations[0])}${link(h.current > 0)}${station(1, h.stations[1])}${link(h.current > 1)}${station(2, h.stations[2])}</tr>`,
          FULL,
        ),
        '22px 34px 0',
      );
    }
    case 'sign':
      return row(
        `<div align="center">${circle(10, `background-color:${C.muted}`, '&nbsp;')}</div><div align="center" style="padding-top:10px">${T(`<tr><td class="bos-acc" bgcolor="${acc}" align="center" style="background-color:${acc};border-radius:16px;padding:8px 46px 16px;text-align:center"><div style="${disp(110, on)}">${e(h.word)}</div><div style="font-family:${FONT};font-size:13px;letter-spacing:2px;color:${on}">${e(h.sub)}</div></td></tr>`)}</div>`,
        '30px 34px 4px',
      );
    case 'state': {
      const color = h.tone === 'no' ? S.bad : h.tone === 'ok' ? S.ok : acc;
      const bg = h.tone === 'wait' ? soft : C.card;
      return row(
        circle(84, `background-color:${bg};border:3px solid ${color};${disp(44, color)}`, e(h.glyph)),
        '30px 34px 0',
      );
    }
    case 'seats': {
      const seat = (p: { initial: string; color: string }) =>
        `<td align="center" style="padding:0 5px">${circle(56, `background-color:${p.color};font-family:${FONT};font-size:20px;color:#ffffff`, e(p.initial))}</td>`;
      const me = `<td align="center" style="padding:0 5px">${circle(52, `border:2px dashed ${accText};font-family:${FONT};font-size:12px;line-height:1.15;color:${accText}`, e(h.me))}</td>`;
      const seats = `<div align="center">${T(`<tr>${h.people.slice(0, 5).map(seat).join('')}${me}</tr>`)}</div>`;
      const caption = h.caption
        ? `<div class="bos-muted" style="font-family:${FONT};font-size:12px;color:${C.muted};text-align:center;padding-top:8px">${e(h.caption)}</div>`
        : '';
      const note = h.note
        ? `<div align="center" style="padding-top:18px">${T(`<tr><td bgcolor="${S.note}" style="background-color:${S.note};border-radius:3px;padding:16px 22px 14px;font-family:'Amatic SC',${FONT};font-size:24px;line-height:1.2;color:${S.noteInk};max-width:300px;white-space:pre-wrap;text-align:${x.start};box-shadow:0 14px 22px -14px rgba(0,0,0,.45)">${e(h.note.text)}${h.note.by ? `<div style="font-size:18px;text-align:${x.end};padding-top:6px">— ${e(h.note.by)}</div>` : ''}</td></tr>`)}</div>`
        : '';
      const days = h.days
        ? `<div style="padding-top:20px;border-top:2px dashed ${C.line};margin-top:20px" class="bos-line">${T(`<tr>${Array.from({ length: Math.min(h.days.total, 14) }, () => `<td style="padding-${x.end}:4px"><div style="width:14px;height:20px;border-radius:4px;background-color:${acc};font-size:0;line-height:0">&nbsp;</div></td>`).join('')}<td class="bos-muted" style="${f};font-size:12.5px;color:${C.muted};padding-${x.start}:10px">${e(h.days.label)}</td></tr>`)}</div>`
        : '';
      return row(seats + caption + note + days, '22px 34px 0');
    }
    case 'poster':
      return row(
        T(
          `<tr><td class="bos-acc" bgcolor="${acc}" style="background-color:${acc};border-radius:20px;padding:30px 30px 28px">${
            h.badge
              ? `<div align="${x.end}">${circle(92, `border:1px solid ${on};font-family:${FONT};font-size:12px;line-height:1.3;color:${on}`, e(h.badge))}</div>`
              : ''
          }<div style="${f};${disp(fit(x.title, 100), on)};white-space:pre-line">${e(x.title)}</div></td></tr>`,
          FULL,
        ),
        '28px 34px 0',
      );
    case 'bubble': {
      const crumb = h.crumb
        ? `<div class="bos-muted" style="${f};font-size:12.5px;color:${C.muted};padding-bottom:12px">${e(h.crumb)}</div>`
        : '';
      const bubble = T(
        `<tr><td class="bos-tint" bgcolor="${soft}" style="background-color:${soft};border-radius:26px;padding:22px 26px;font-family:${SERIF};font-size:26px;line-height:1.35;color:${C.ink};text-align:${x.start};white-space:pre-wrap"><span style="font-size:56px;line-height:.4;color:${accText};display:block;height:22px">&rdquo;</span>${e(h.quote)}</td></tr>`,
        FULL,
      );
      const who = T(
        `<tr><td width="40" valign="middle">${circle(36, `background-color:${avatarColor(h.who.name)};font-family:${FONT};font-size:15px;color:#ffffff`, e(initialOf(h.who.name)))}</td><td valign="middle" class="bos-ink" style="${f};font-size:14.5px;line-height:1.45;color:${C.ink};padding-${x.start}:10px">${e(x.title)}${h.who.line ? `<br><span class="bos-muted" style="font-size:12px;color:${C.muted}">${e(h.who.line)}</span>` : ''}</td></tr>`,
      );
      return row(`${crumb}${bubble}<div style="padding-top:16px">${who}</div>`, '24px 34px 0');
    }
    case 'row':
      return row(
        `${h.crumb ? `<div class="bos-muted" style="${f};font-size:12.5px;color:${C.muted};padding-bottom:10px">${e(h.crumb)}</div>` : ''}${T(
          `<tr><td width="5" class="bos-acc" bgcolor="${acc}" style="background-color:${acc};border-radius:${x.start === 'right' ? '0 12px 12px 0' : '12px 0 0 12px'}"></td><td class="bos-ink" style="${f};padding:14px 16px;font-size:15px;color:${C.ink}">${e(h.name)}${h.meta ? `<br><span class="bos-muted" style="font-size:12px;color:${C.muted}">${e(h.meta)}</span>` : ''}</td></tr>`,
          ` width="100%" class="bos-card bos-line" style="border:1px solid ${C.line};border-radius:12px;border-collapse:separate"`,
        )}`,
        '18px 34px 0',
      );
    case 'paper': {
      const mast = `<div class="bos-head" style="font-family:${SERIF};font-weight:500;font-size:60px;line-height:1;letter-spacing:-1px;text-align:center;color:${C.ink}">${e(h.masthead)}</div>${T(
        `<tr>${h.edition.map((s, i) => `<td class="bos-muted" align="${i === 0 ? x.start : i === h.edition.length - 1 ? x.end : 'center'}" style="font-family:${FONT};font-size:11.5px;color:${C.muted};padding:6px 0">${e(s)}</td>`).join('')}</tr>`,
        ` width="100%" class="bos-line" style="border-top:1px solid ${C.ink};border-bottom:3px double ${C.ink};margin-top:8px"`,
      )}`;
      const nums = h.numbers
        .map(
          (n) =>
            `<div class="bos-line bos-muted" style="font-family:${FONT};font-size:12px;color:${C.muted};border-bottom:1px solid ${C.line};padding:6px 0 8px"><div class="bos-ink" style="${disp(50, C.ink)}">${n.n}</div>${e(n.label)}</div>`,
        )
        .join('');
      const lead = h.lead
        ? `<div style="font-family:${FONT};font-size:11.5px;letter-spacing:1px;color:${accText}">${e(h.lead.kicker)}</div><a class="bos-ink" href="${e(h.lead.url)}" target="_blank" style="display:block;font-family:${SERIF};font-weight:500;font-size:27px;line-height:1.2;color:${C.ink};text-decoration:none;padding:4px 0 8px">${e(h.lead.head)}</a>${h.lead.dek ? `<div class="bos-body" style="font-family:${SERIF};font-size:16px;line-height:1.5;color:${C.body}">${e(h.lead.dek)}</div>` : ''}`
        : `<div class="bos-head" style="font-family:${SERIF};font-size:26px;line-height:1.2;color:${C.ink}">${e(x.title)}</div>`;
      const cols = T(
        `<tr><td valign="top" style="${f};padding-${x.end}:18px">${lead}</td><td width="150" valign="top" class="bos-line" style="${f};border-${x.start}:1px solid ${C.line};padding-${x.start}:18px">${nums}</td></tr>`,
        ` width="100%" style="margin-top:16px"`,
      );
      return row(mast + cols, '26px 30px 0');
    }
    case 'letterhead':
      return '';
    case 'bars': {
      const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      const bottom = ['#131313', '#ebebeb', '#131313', '#ebebeb', '#131313', '#ebebeb', '#131313'];
      const line = (cs: string[], hgt: number) =>
        `<tr>${cs.map((c) => `<td bgcolor="${c}" style="background-color:${c};height:${hgt}px;font-size:0;line-height:0">&nbsp;</td>`).join('')}</tr>`;
      const plate = `<div align="center" style="padding-top:18px">${T(`<tr><td bgcolor="#101010" align="center" style="background-color:#101010;border-radius:6px;padding:12px 24px;text-align:center"><div style="${disp(44, '#ffffff')}">${e(h.word)}</div><div dir="ltr" style="font-family:${MONO};font-size:11px;color:#bdbdbd;padding-top:4px">${e(h.detail)}</div></td></tr>`)}</div>`;
      return `<tr><td style="padding:0;border-radius:20px 20px 0 0;overflow:hidden">${T(line(top, 130) + line(bottom, 20), ' width="100%" dir="ltr"')}</td></tr>${row(plate, '0 34px 0')}`;
    }
    case 'tag':
      return row(
        T(
          `<tr><td class="bos-acc" bgcolor="${acc}" style="background-color:${acc};border-radius:18px;padding:22px 26px">${T(
            `<tr><td valign="bottom" style="${f}"><div style="font-family:${FONT};font-size:12px;color:${on}">${e(h.numberLabel)}</div><div dir="ltr" style="${disp(96, on)};text-align:${x.start}">${e(h.number)}</div></td><td valign="bottom" align="${x.end}">${kv(h.fields, on, on, x.start)}</td></tr>`,
            FULL,
          )}<div style="font-family:${FONT};font-size:15px;color:${on};padding:12px 0 14px;text-align:${x.start}">${e(h.subject)}</div>${barcode(on)}</td><td width="40" valign="middle" align="center"><div style="width:18px;height:18px;border-radius:50%;border:3px solid ${mid};font-size:0;line-height:0">&nbsp;</div></td></tr>`,
          FULL,
        ),
        '20px 34px 0',
      );
    case 'thread':
      return '';
    case 'flaps': {
      const tile = (ch: string, accent: boolean) =>
        ch === ' '
          ? '<td width="10" style="width:10px"></td>'
          : `<td style="padding-${x.end}:3px"><div style="width:28px;height:40px;line-height:40px;border-radius:4px;background-color:${accent ? mix(acc, '#232627', 0.6) : '#232627'};color:${accent ? mix(acc, '#ffffff', 0.25) : '#f3efe4'};font-family:${FONT};font-size:22px;text-align:center;border-bottom:1px solid #0b0c0c">${e(ch)}</div></td>`;
      const rows = h.rows
        .map(
          (r) =>
            `<tr><td width="96" style="font-family:${FONT};font-size:12px;color:#8b8f88;border-top:1px solid #26292a;padding:7px 0;text-align:${x.start}">${e(r.label)}</td><td style="border-top:1px solid #26292a;padding:7px 0">${T(
              `<tr>${Array.from(r.value.slice(0, 16))
                .map((ch) => tile(ch, !!r.accent))
                .join('')}</tr>`,
              r.ltr ? ' dir="ltr"' : '',
            )}</td></tr>`,
        )
        .join('');
      return row(
        T(
          `<tr><td bgcolor="${S.board}" style="background-color:${S.board};border-radius:16px;padding:18px 22px">${T(
            `<tr><td colspan="2" style="font-family:${FONT};font-size:11px;letter-spacing:2px;color:#8b8f88;padding-bottom:8px;text-align:${x.start}">${e(h.head)}</td></tr>${rows}`,
            FULL,
          )}</td></tr>`,
          FULL,
        ),
        '20px 34px 0',
      );
    }
    case 'seal': {
      const env = T(
        `<tr><td class="bos-tint" bgcolor="${soft}" align="center" valign="middle" style="background-color:${soft};border:1px solid ${mid};border-radius:14px;height:150px;text-align:center">${`<div align="center">${circle(72, `background-color:#a3212a;border:4px solid #c8323a;font-family:'Suez One',${FONT};font-size:30px;color:#f6cfc6`, e(h.letter))}</div>`}</td></tr>`,
        FULL,
      );
      return row(env, '28px 34px 0');
    }
    case 'count': {
      const color = h.tone === 'bad' ? S.bad : accText;
      return row(
        `<div style="${f};${disp(110, color)}">${e(h.n)}</div><div class="bos-muted" style="${f};font-size:14px;color:${C.muted};padding-top:4px">${e(h.unit)}</div>`,
        '18px 34px 0',
      );
    }
    case 'ticket':
      return row(
        T(
          `<tr><td valign="top" style="${f};padding:22px 24px"><div class="bos-muted" style="font-family:${FONT};font-size:12px;color:${C.muted}">${e(h.caption)}</div><div class="bos-ink" style="font-family:${SERIF};font-size:26px;line-height:1.25;color:${C.ink};padding:2px 0 12px">${e(h.name)}</div>${kv(h.fields, C.muted, C.ink, x.start)}</td><td width="130" align="center" valign="middle" style="border-${x.start}:2px dashed ${mid};text-align:center;padding:16px 8px"><div style="${disp(52, accText)}">${e(h.stub)}</div><div style="padding-top:12px">${T(`<tr><td style="border:3px solid ${S.ok};border-radius:8px;padding:0 12px;font-family:'Suez One',${FONT};font-size:24px;color:${S.ok}">${e(h.stamp)}</td></tr>`)}</div></td></tr>`,
          ` width="100%" class="bos-tint" bgcolor="${soft}" style="background-color:${soft};border:1px solid ${mid};border-radius:18px;border-collapse:separate"`,
        ),
        '20px 34px 0',
      );
    case 'card': {
      const card = T(
        `<tr><td class="bos-acc" bgcolor="${acc}" style="background-color:${acc};background-image:linear-gradient(135deg,${mix('#000000', acc, 0.25)},${acc} 60%,${mix('#ffffff', acc, 0.35)});border-radius:16px;padding:20px 22px;height:150px" valign="top">${T(
          `<tr><td><div style="width:44px;height:32px;border-radius:6px;background-color:#d4b864;font-size:0;line-height:0">&nbsp;</div></td><td align="${x.end}">${T(`<tr><td bgcolor="${S.bad}" style="background-color:${S.bad};border-radius:6px;padding:2px 16px;font-family:'Suez One',${FONT};font-size:24px;color:#ffffff">${e(h.stamp)}</td></tr>`)}</td></tr>`,
          FULL,
        )}${h.last4 ? `<div dir="ltr" style="font-family:${MONO};font-size:17px;letter-spacing:2px;color:${on};padding-top:40px;text-align:left">•••• •••• •••• ${e(h.last4)}</div>` : ''}</td></tr>`,
        ` width="340" style="width:100%;max-width:340px"`,
      );
      return row(`<div align="center">${card}</div>`, '28px 34px 0');
    }
    case 'calendar': {
      const rings = T(
        `<tr><td style="padding:0 50px"><div style="width:12px;height:22px;border-radius:7px;background-color:${C.ink};font-size:0;line-height:0">&nbsp;</div></td><td style="padding:0 50px"><div style="width:12px;height:22px;border-radius:7px;background-color:${C.ink};font-size:0;line-height:0">&nbsp;</div></td></tr>`,
      );
      const page = T(
        `<tr><td class="bos-acc" bgcolor="${acc}" align="center" style="background-color:${acc};color:${on};font-family:${FONT};font-size:13px;letter-spacing:1px;padding:10px;text-align:center;border-radius:14px 14px 0 0">${e(h.head)}</td></tr><tr><td align="center" class="bos-ink" style="${disp(170, C.ink)};text-align:center;padding-top:14px">${h.n}</td></tr><tr><td align="center" class="bos-muted" style="font-family:${FONT};font-size:14px;color:${C.muted};padding:6px 12px 16px;text-align:center">${e(h.unit)}</td></tr>`,
        ` width="240" class="bos-card bos-line" bgcolor="${C.card}" style="width:240px;background-color:${C.card};border:1px solid ${C.line};border-radius:14px;border-collapse:separate;box-shadow:7px 7px 0 -1px ${C.card},7px 7px 0 0 ${C.line},14px 14px 0 -1px ${C.card},14px 14px 0 0 ${C.line}"`,
      );
      return row(
        `<div align="center">${rings}</div><div align="center" style="margin-top:-10px">${page}</div>`,
        '30px 34px 8px',
      );
    }
    case 'vitrine': {
      const bars = [
        [1, S.ok],
        [0.7, S.warn],
        [0.85, S.bad],
        [0.6, S.ok],
      ] as const;
      const rows = bars
        .map(
          ([w, c]) =>
            `<tr><td width="5" class="bos-acc" style="background-color:${acc};border-radius:2px;height:26px"></td><td style="padding:8px 10px"><div class="bos-line" style="height:10px;width:${Math.round(w * 100)}%;border-radius:5px;background-color:${C.line};font-size:0;line-height:0">&nbsp;</div></td><td width="70" style="padding:6px 0"><div style="height:22px;border-radius:5px;background-color:${c};opacity:.55;font-size:0;line-height:0">&nbsp;</div></td></tr>`,
        )
        .join('');
      const lock = `<div align="center" style="padding-top:14px">${T(`<tr><td bgcolor="${C.ink}" style="background-color:${C.ink};border-radius:999px;padding:8px 18px;font-family:${FONT};font-size:14px;color:${C.card}">&#128274;&#xFE0E; ${e(h.label)}</td></tr>`)}</div>`;
      return row(
        T(
          `<tr><td class="bos-quote" bgcolor="${C.soft}" style="background-color:${C.soft};background-image:linear-gradient(115deg,transparent 25%,rgba(255,255,255,.6) 33%,transparent 40%);border:1px solid ${C.line};border-radius:14px;padding:14px 16px">${T(rows, FULL)}${lock}</td></tr>`,
          FULL,
        ),
        '18px 34px 0',
      );
    }
    case 'days': {
      const cells = Array.from(
        { length: Math.min(h.total, 60) },
        (_, i) =>
          `<td style="padding:0 ${x.end === 'left' ? '0 5px 5px' : '5px 5px 0'}"><div style="width:22px;height:22px;border-radius:4px;background-color:${i < h.done ? S.bad : C.line};font-size:0;line-height:0">&nbsp;</div></td>`,
      );
      const lines: string[] = [];
      for (let i = 0; i < cells.length; i += 15) lines.push(`<tr>${cells.slice(i, i + 15).join('')}</tr>`);
      return row(
        `<div class="bos-ink" style="${f};${disp(76, C.ink)}">${e(h.big)}</div><div style="padding-top:16px">${T(lines.join(''))}</div><div class="bos-muted" style="${f};font-size:12.5px;color:${C.muted};padding-top:4px">${e(h.caption)}</div>`,
        '18px 34px 0',
      );
    }
    case 'fade': {
      const widths = [100, 80, 55, 30, 12];
      const ops = [1, 0.7, 0.45, 0.25, 0.12];
      return row(
        `<div class="bos-ink" style="${f};font-family:${SERIF};font-size:30px;line-height:1.25;color:${C.ink}">${e(x.title)}</div>${widths
          .map(
            (w, i) =>
              `<div class="bos-line" style="height:10px;width:${w}%;border-radius:5px;background-color:${C.line};opacity:${ops[i]};margin-top:12px;font-size:0;line-height:0">&nbsp;</div>`,
          )
          .join('')}`,
        '60px 34px 10px',
      );
    }
    case 'crate':
      return row(
        T(
          `<tr><td valign="top" style="${f};padding:16px 18px"><div class="bos-ink" style="font-family:${FONT};font-size:12.5px;color:${C.ink}">${e(h.caption)}</div><div class="bos-ink" style="${disp(56, C.ink)};padding:4px 0 10px">${e(h.name)}</div>${kv(h.fields, C.muted, C.ink, x.start)}<div style="padding-top:12px">${T(`<tr>${h.formats.map((s) => `<td style="padding-${x.end}:6px"><span class="bos-line bos-ink" style="border:1px solid ${C.ink};border-radius:4px;padding:1px 8px;font-family:${MONO};font-size:12px;color:${C.ink}">${e(s)}</span></td>`).join('')}</tr>`)}</div></td><td width="140" valign="middle" align="center" class="bos-line" style="border-${x.start}:2px solid ${C.ink};padding:14px 10px;text-align:center"><div class="bos-ink" style="font-family:${FONT};font-size:34px;line-height:1;color:${C.ink}">&uarr;&uarr;</div><div style="padding:12px 0">${T(`<tr><td style="border:2px solid ${S.bad};border-radius:4px;padding:2px 8px;font-family:'Suez One',${FONT};font-size:16px;color:${S.bad}">${e(h.stamp)}</td></tr>`)}</div>${barcode(C.ink, 30)}</td></tr>`,
          ` width="100%" class="bos-line" style="border:2px solid ${C.ink};border-radius:6px;border-collapse:separate"`,
        ),
        '18px 34px 0',
      );
    case 'code': {
      const segs = h.code
        .split('-')
        .map(
          (s) =>
            `<td style="padding:0 4px"><span style="display:inline-block;font-family:${MONO};font-size:20px;letter-spacing:2px;color:#ffffff;background-color:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px 10px">${e(s)}</span></td>`,
        )
        .join('');
      return row(
        T(
          `<tr><td bgcolor="${C.ink}" style="background-color:${C.ink};background-image:radial-gradient(circle at 0 0,${mix(acc, '#ffffff', 0.6)} 0,transparent 45%);border-radius:20px;padding:24px 26px"><div style="${f};font-family:${FONT};font-size:13px;color:#cfd8d5">${e(h.caption)}</div><div style="${f};${disp(64, '#ffffff')};padding-top:6px">${e(x.title)}</div><div align="center" style="padding:18px 0 6px">${T(`<tr>${segs}</tr>`, ' dir="ltr"')}</div>${T(`<tr><td style="font-family:${FONT};font-size:12px;color:#cfd8d5;text-align:${x.start}">${e(h.meta[0])}</td><td align="${x.end}" style="font-family:${FONT};font-size:12px;color:#cfd8d5">${e(h.meta[1])}</td></tr>`, FULL)}</td></tr>`,
          FULL,
        ),
        '28px 34px 0',
      );
    }
  }
};

/** The answer of a support reply as a chat bubble (the thread hero's body). */
export const threadBody = (lines: string[], who: string, when: string | undefined, accent: string, start: string) => {
  const on = onAccent(accent);
  return T(
    `<tr><td class="bos-acc" bgcolor="${accent}" style="background-color:${accent};border-radius:18px 18px ${start === 'right' ? '18px 4px' : '4px 18px'};padding:14px 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:${on};text-align:${start};white-space:pre-wrap"><div style="font-size:11.5px;opacity:.8;padding-bottom:4px">${e(who)}${when ? ` · ${e(when)}` : ''}</div>${lines.map((l) => e(l)).join('<br><br>')}</td></tr>`,
    ' width="100%" style="margin:4px 0 16px"',
  );
};

/** "Chrome · Windows" from a User-Agent (the sign-in email's "who asked" line); null when it says nothing known. */
export const deviceOf = (ua: string | null | undefined): string | null => {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' · ') || null;
};
