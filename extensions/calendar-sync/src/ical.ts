// SPDX-License-Identifier: AGPL-3.0-only
/**
 * iCalendar (RFC 5545), only as much as the CalDAV provider needs: a component tree reader / writer (unfolding,
 * folding at 75 octets, TEXT escaping), DATE / DATE-TIME values (UTC, TZID by IANA name or by the file's own
 * VTIMEZONE, floating as UTC), DURATION, and VEVENT ↔ the provider's `ProviderEvent` / `EventData`.
 */
import { addDays, type IsoDate } from '@bines/shared';
import type { AttendeeAnswer, EventData, ProviderEvent, Rsvp, When, WriteOpts } from './provider';

export type Prop = { name: string; params: Record<string, string>; value: string };
export type Component = { name: string; props: Prop[]; children: Component[] };

// -------------------------------------------------------------------------------------------------------------
// Reading and writing the text
// -------------------------------------------------------------------------------------------------------------

const parseLine = (line: string): Prop | null => {
  let i = 0;
  while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const key = line.slice(i, eq).toUpperCase();
    i = eq + 1;
    let value = '';
    // A parameter value: quoted parts and plain parts, several separated by commas.
    while (i < line.length && line[i] !== ';' && line[i] !== ':') {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) return null;
        value += line.slice(i + 1, end);
        i = end + 1;
      } else value += line[i++];
    }
    params[key] = value;
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
};

/** The components of a text (usually one VCALENDAR). Lines it cannot read are skipped. */
export const parseIcal = (text: string): Component[] => {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: Component[] = [];
  const stack: Component[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const c: Component = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      (stack.length ? stack[stack.length - 1]!.children : out).push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      if (stack.length && stack[stack.length - 1]!.name === p.value.trim().toUpperCase()) stack.pop();
    } else if (stack.length) stack[stack.length - 1]!.props.push(p);
  }
  return out;
};

const quoteParam = (v: string) => (/[:;,]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/** A content line folded at 75 octets (continuation lines start with a space). */
export const foldLine = (line: string): string => {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
};

export const serializeIcal = (c: Component): string => {
  const lines: string[] = [];
  const walk = (x: Component) => {
    lines.push(`BEGIN:${x.name}`);
    for (const p of x.props) {
      const params = Object.entries(p.params)
        .map(([k, v]) => `;${k}=${quoteParam(v)}`)
        .join('');
      lines.push(foldLine(`${p.name}${params}:${p.value}`));
    }
    for (const ch of x.children) walk(ch);
    lines.push(`END:${x.name}`);
  };
  walk(c);
  return `${lines.join('\r\n')}\r\n`;
};

export const unescapeText = (v: string) =>
  v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
export const escapeText = (v: string) =>
  v.replace(/\r\n?/g, '\n').replace(/[\\;,\n]/g, (c) => (c === '\n' ? '\\n' : `\\${c}`));

export const prop = (c: Component | undefined, name: string) => c?.props.find((p) => p.name === name);
export const props = (c: Component | undefined, name: string) => (c?.props ?? []).filter((p) => p.name === name);
const text = (c: Component, name: string) => {
  const p = prop(c, name);
  return p ? unescapeText(p.value) : null;
};
/** Sets (replaces) a property; null removes it. */
export const setProp = (c: Component, name: string, value: string | null, params: Record<string, string> = {}) => {
  const at = c.props.findIndex((p) => p.name === name);
  c.props = c.props.filter((p) => p.name !== name);
  if (value === null) return;
  const next = { name, params, value };
  if (at < 0) c.props.push(next);
  else c.props.splice(at, 0, next);
};

// -------------------------------------------------------------------------------------------------------------
// Time
// -------------------------------------------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
const formatter = (tz: string) => {
  if (!fmtCache.has(tz)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      f = null;
    }
    fmtCache.set(tz, f);
  }
  return fmtCache.get(tz)!;
};
export const isZone = (tz: string) => !!formatter(tz);

/** How far `tz`'s wall clock is ahead of UTC at an instant (ms). */
const zoneOffset = (utcMs: number, tz: string) => {
  const parts = formatter(tz)!.formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
};

/** A wall-clock time (as if UTC, ms) in a zone → the instant. */
const fromWall = (wall: number, offsetAt: (utcMs: number) => number) => {
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
};

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };
const WALL = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;
const readWall = (v: string): (Wall & { date: boolean; utc: boolean }) | null => {
  const m = WALL.exec(v.trim());
  if (!m) return null;
  return {
    y: +m[1]!,
    mo: +m[2]!,
    d: +m[3]!,
    h: +(m[4] ?? 0),
    mi: +(m[5] ?? 0),
    s: +(m[6] ?? 0),
    date: m[4] === undefined,
    utc: m[7] === 'Z',
  };
};
const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

const offsetValue = (v: string | undefined) => {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((v ?? '').trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((+m[2]! * 60 + +m[3]!) * 60 + +(m[4] ?? 0)) * 1000;
};

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** When an observance (STANDARD / DAYLIGHT) starts in a year, wall-clock ms (its yearly BYMONTH + BYDAY rule). */
const onsetIn = (obs: Component, year: number): number | null => {
  const start = readWall(prop(obs, 'DTSTART')?.value ?? '');
  if (!start) return null;
  const rule = prop(obs, 'RRULE')?.value;
  if (!rule) return year === start.y ? wallMs(start) : null;
  const parts = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]));
  if (parts.FREQ !== 'YEARLY') return null;
  const month = parts.BYMONTH ? +parts.BYMONTH : start.mo;
  const bd = /^([+-]?\d)?([A-Z]{2})$/.exec(parts.BYDAY ?? '');
  if (!bd) return Date.UTC(year, month - 1, start.d, start.h, start.mi, start.s);
  const dow = DAYS.indexOf(bd[2]!);
  const n = bd[1] ? +bd[1] : 1;
  let day: number;
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  } else {
    const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const last = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
    day = lastDate - ((last - dow + 7) % 7) + (n + 1) * 7;
  }
  return Date.UTC(year, month - 1, day, start.h, start.mi, start.s);
};

/** A VTIMEZONE's offset at a wall-clock time: the observance that started last before it. */
const vtimezoneOffset = (tz: Component) => (utcMs: number) => {
  const year = new Date(utcMs).getUTCFullYear();
  let best: { at: number; off: number } | null = null;
  for (const obs of tz.children) {
    const off = offsetValue(prop(obs, 'TZOFFSETTO')?.value);
    if (off === null) continue;
    for (const y of [year - 1, year]) {
      const at = onsetIn(obs, y);
      if (at !== null && at <= utcMs + off && (!best || at > best.at)) best = { at, off };
    }
  }
  if (best) return best.off;
  const std = tz.children.find((o) => o.name === 'STANDARD') ?? tz.children[0];
  return offsetValue(prop(std, 'TZOFFSETTO')?.value) ?? 0;
};

/** The zones a calendar file defines (TZID → offset function). */
export type Zones = Map<string, (utcMs: number) => number>;
export const zonesOf = (cal: Component | undefined): Zones => {
  const out: Zones = new Map();
  for (const tz of (cal?.children ?? []).filter((c) => c.name === 'VTIMEZONE')) {
    const id = prop(tz, 'TZID')?.value;
    if (!id) continue;
    const named = prop(tz, 'X-LIC-LOCATION')?.value;
    out.set(id, named && isZone(named) ? (ms) => zoneOffset(ms, named) : vtimezoneOffset(tz));
  }
  return out;
};

const offsetFn = (tzid: string | undefined, zones: Zones): ((ms: number) => number) => {
  if (!tzid) return () => 0;
  const id = tzid.replace(/^\//, '');
  if (isZone(id)) return (ms) => zoneOffset(ms, id);
  return zones.get(tzid) ?? (() => 0);
};

export type TimeValue = { kind: 'date'; date: IsoDate } | { kind: 'time'; iso: string };
const isoDate = (w: Wall) =>
  `${String(w.y).padStart(4, '0')}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}` as IsoDate;

/** A DATE or DATE-TIME property value (TZID by IANA name or by the file's VTIMEZONE; floating = UTC). */
export const readTime = (p: Prop | undefined, zones: Zones): TimeValue | null => {
  if (!p) return null;
  const w = readWall(p.value);
  if (!w) return null;
  if (w.date || p.params.VALUE === 'DATE') return { kind: 'date', date: isoDate(w) };
  const ms = w.utc ? wallMs(w) : fromWall(wallMs(w), offsetFn(p.params.TZID, zones));
  return { kind: 'time', iso: new Date(ms).toISOString() };
};

/** `20261110T080000Z` (UTC) / `20261110` (a day). */
export const utcStamp = (iso: string) => `${iso.replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15)}Z`;
export const dateStamp = (d: string) => d.replace(/-/g, '');

/** A recurrence key: the UTC stamp of a DATE-TIME, or the day of a DATE. */
export const recurrenceKey = (p: Prop | undefined, zones: Zones) => {
  const t = readTime(p, zones);
  if (!t) return null;
  return t.kind === 'date' ? dateStamp(t.date) : utcStamp(t.iso);
};

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
/** An iCalendar DURATION in ms (null when it is not one). */
export const durationMs = (v: string | undefined) => {
  const m = DURATION.exec((v ?? '').trim());
  if (!m) return null;
  const ms = ((((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
};

/** When a VEVENT happens (DTEND, or DTSTART + DURATION; a day when neither). */
export const whenOf = (ev: Component, zones: Zones): When | null => {
  const start = readTime(prop(ev, 'DTSTART'), zones);
  if (!start) return null;
  const end = readTime(prop(ev, 'DTEND'), zones);
  const dur = durationMs(prop(ev, 'DURATION')?.value);
  if (start.kind === 'date') {
    // DTEND of a day is exclusive.
    let to: IsoDate = start.date;
    if (end?.kind === 'date' && end.date > start.date) to = addDays(end.date, -1);
    else if (dur && dur >= 86_400_000) to = addDays(start.date, Math.round(dur / 86_400_000) - 1);
    return { kind: 'allday', from: start.date, to };
  }
  const s = Date.parse(start.iso);
  const e = end?.kind === 'time' ? Date.parse(end.iso) : dur !== null ? s + dur : s;
  return { kind: 'timed', start: new Date(s).toISOString(), end: new Date(Math.max(s, e)).toISOString() };
};

// -------------------------------------------------------------------------------------------------------------
// VEVENT → ProviderEvent
// -------------------------------------------------------------------------------------------------------------

const mailto = (v: string | undefined) => {
  const s = (v ?? '').trim().replace(/^mailto:/i, '');
  return s.includes('@') ? s.toLowerCase() : null;
};
const PARTSTAT: Record<string, Rsvp> = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative' };
const isGuest = (p: Prop) => !['ROOM', 'RESOURCE'].includes((p.params.CUTYPE ?? '').toUpperCase()) && !!mailto(p.value);
const stampIso = (v: string | undefined) => {
  const w = readWall(v ?? '');
  return w ? new Date(wallMs(w)).toISOString() : null;
};
const MEETING = /https:\/\/[^\s]*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|whereby\.com|jitsi)[^\s]*/i;

export const eventFromVevent = (
  v: Component,
  zones: Zones,
  ids: { id: string; recurringEventId: string | null },
  ownEmail: string | null,
): ProviderEvent => {
  const organizer = mailto(prop(v, 'ORGANIZER')?.value);
  const guests = props(v, 'ATTENDEE').filter(isGuest);
  const responses: AttendeeAnswer[] = guests.map((a) => {
    const email = mailto(a.value)!;
    return {
      email,
      status: PARTSTAT[(a.params.PARTSTAT ?? '').toUpperCase()] ?? 'needsAction',
      organizer: email === organizer,
    };
  });
  const status = (prop(v, 'STATUS')?.value ?? '').toUpperCase();
  const url = prop(v, 'X-GOOGLE-CONFERENCE')?.value ?? prop(v, 'URL')?.value ?? '';
  const meet = MEETING.exec(url)?.[0] ?? null;
  return {
    id: ids.id,
    status: status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    updated: stampIso(prop(v, 'LAST-MODIFIED')?.value) ?? stampIso(prop(v, 'DTSTAMP')?.value),
    created: stampIso(prop(v, 'CREATED')?.value),
    title: text(v, 'SUMMARY') ?? '',
    description: text(v, 'DESCRIPTION'),
    location: text(v, 'LOCATION'),
    meetLink: meet,
    organizerEmail: organizer,
    attendees: [...new Set(responses.map((r) => r.email))].sort(),
    responses,
    when: whenOf(v, zones),
    recurring: !prop(v, 'RECURRENCE-ID') && (!!prop(v, 'RRULE') || !!prop(v, 'RDATE')),
    recurringEventId: ids.recurringEventId,
    icalUid: prop(v, 'UID')?.value ?? null,
    // An invitation from someone else is theirs to change (their copy carries the changes).
    canEdit: !organizer || !ownEmail || organizer === ownEmail.toLowerCase(),
    marks: {
      ...(prop(v, 'X-BINES-ITEM-ID') ? { binesItemId: prop(v, 'X-BINES-ITEM-ID')!.value } : {}),
      ...(prop(v, 'X-BINES-INSTALLATION') ? { binesInstallation: prop(v, 'X-BINES-INSTALLATION')!.value } : {}),
    },
  };
};

/** The id of one instance of a series stored at `href`. */
export const instanceId = (href: string, key: string) => `${href}#${key}`;
export const splitInstanceId = (id: string) => {
  const at = id.lastIndexOf('#');
  return at < 0 ? { href: id, key: null } : { href: id.slice(0, at), key: id.slice(at + 1) };
};

const blank = (id: string, recurringEventId: string | null): ProviderEvent => ({
  id,
  status: 'cancelled',
  updated: null,
  created: null,
  title: '',
  description: null,
  location: null,
  meetLink: null,
  organizerEmail: null,
  attendees: [],
  responses: [],
  when: null,
  recurring: false,
  recurringEventId,
  icalUid: null,
  canEdit: true,
  marks: {},
});
export const cancelledEvent = (id: string, recurringEventId: string | null = null) => blank(id, recurringEventId);

/**
 * The events of one calendar resource (`href`): a single event; a series' master (its instances are read with
 * `listInstances`) plus each excluded date as a cancelled instance; or, with no master (an invitation to one
 * instance), each instance.
 */
export const eventsOfResource = (body: string, href: string, ownEmail: string | null): ProviderEvent[] => {
  const cal = parseIcal(body).find((c) => c.name === 'VCALENDAR');
  if (!cal) return [];
  const zones = zonesOf(cal);
  const vevents = cal.children.filter((c) => c.name === 'VEVENT');
  const master = vevents.find((v) => !prop(v, 'RECURRENCE-ID'));
  if (master) {
    const ev = eventFromVevent(master, zones, { id: href, recurringEventId: null }, ownEmail);
    if (!ev.recurring) return [ev];
    const exdates = props(master, 'EXDATE').flatMap((p) =>
      p.value.split(',').map((value) => recurrenceKey({ ...p, value }, zones)),
    );
    return [ev, ...exdates.filter((k): k is string => !!k).map((k) => cancelledEvent(instanceId(href, k), href))];
  }
  return vevents.map((v) =>
    eventFromVevent(
      v,
      zones,
      { id: instanceId(href, recurrenceKey(prop(v, 'RECURRENCE-ID'), zones) ?? ''), recurringEventId: href },
      ownEmail,
    ),
  );
};

/** The instances of an expanded series (each VEVENT has a RECURRENCE-ID; null when the server did not expand). */
export const instancesOfResource = (body: string, href: string, ownEmail: string | null): ProviderEvent[] | null => {
  const cal = parseIcal(body).find((c) => c.name === 'VCALENDAR');
  if (!cal) return [];
  const zones = zonesOf(cal);
  const vevents = cal.children.filter((c) => c.name === 'VEVENT');
  if (vevents.some((v) => prop(v, 'RRULE'))) return null;
  return vevents
    .filter((v) => prop(v, 'RECURRENCE-ID'))
    .map((v) =>
      eventFromVevent(
        v,
        zones,
        { id: instanceId(href, recurrenceKey(prop(v, 'RECURRENCE-ID'), zones) ?? ''), recurringEventId: href },
        ownEmail,
      ),
    );
};

/** One instance's override in a series' resource (null when it has none). */
export const overrideOfResource = (
  body: string,
  href: string,
  key: string,
  ownEmail: string | null,
): ProviderEvent | null => {
  const cal = parseIcal(body).find((c) => c.name === 'VCALENDAR');
  if (!cal) return null;
  const zones = zonesOf(cal);
  const v = cal.children.find((c) => c.name === 'VEVENT' && recurrenceKey(prop(c, 'RECURRENCE-ID'), zones) === key);
  return v ? eventFromVevent(v, zones, { id: instanceId(href, key), recurringEventId: href }, ownEmail) : null;
};

// -------------------------------------------------------------------------------------------------------------
// EventData → VEVENT
// -------------------------------------------------------------------------------------------------------------

export const PRODID = '-//Bines OS//Calendar sync//EN';

const nowStamp = () => utcStamp(new Date().toISOString());

const setWhen = (v: Component, when: When) => {
  setProp(v, 'DURATION', null);
  if (when.kind === 'timed') {
    setProp(v, 'DTSTART', utcStamp(when.start));
    setProp(v, 'DTEND', utcStamp(when.end));
  } else {
    setProp(v, 'DTSTART', dateStamp(when.from), { VALUE: 'DATE' });
    setProp(v, 'DTEND', dateStamp(addDays(when.to, 1)), { VALUE: 'DATE' });
  }
};

/**
 * Whether the server sends the invitation (RFC 6638 implicit scheduling) or not (`SCHEDULE-AGENT=CLIENT`):
 * `externalOnly` = only guests outside the organizer's domain.
 */
const scheduleAgent = (email: string, organizer: string | null, how: WriteOpts['sendUpdates']) => {
  if (how === 'all') return null;
  if (how === 'none') return 'CLIENT';
  const domain = (e: string | null) => e?.split('@')[1] ?? '';
  return organizer && domain(email) === domain(organizer) ? 'CLIENT' : null;
};

const setAttendees = (v: Component, wanted: string[], ownEmail: string | null, how: WriteOpts['sendUpdates']) => {
  const current = props(v, 'ATTENDEE');
  const known = new Map(current.filter(isGuest).map((p) => [mailto(p.value)!, p]));
  let organizer = mailto(prop(v, 'ORGANIZER')?.value);
  if (!organizer && wanted.length && ownEmail) {
    organizer = ownEmail.toLowerCase();
    setProp(v, 'ORGANIZER', `mailto:${organizer}`);
  }
  const next = wanted.map((email) => {
    const was = known.get(email);
    const params: Record<string, string> = was
      ? { ...was.params }
      : { CUTYPE: 'INDIVIDUAL', ROLE: 'REQ-PARTICIPANT', PARTSTAT: 'NEEDS-ACTION', RSVP: 'TRUE' };
    delete params['SCHEDULE-AGENT'];
    const agent = scheduleAgent(email, organizer, how);
    if (agent) params['SCHEDULE-AGENT'] = agent;
    return { name: 'ATTENDEE', params, value: was?.value ?? `mailto:${email}` };
  });
  // Rooms and other resources the calendar added stay.
  const resources = current.filter((p) => !isGuest(p));
  v.props = [...v.props.filter((p) => p.name !== 'ATTENDEE'), ...next, ...resources];
};

const applyData = (v: Component, d: EventData, opts: WriteOpts, ownEmail: string | null) => {
  setProp(v, 'SUMMARY', escapeText(d.title));
  if (d.description !== null) setProp(v, 'DESCRIPTION', d.description ? escapeText(d.description) : null);
  if (d.location !== null) setProp(v, 'LOCATION', d.location ? escapeText(d.location) : null);
  setWhen(v, d.when);
  if (d.attendees) setAttendees(v, d.attendees, ownEmail, opts.sendUpdates);
  setProp(v, 'X-BINES-ITEM-ID', opts.marks.binesItemId);
  setProp(v, 'X-BINES-INSTALLATION', opts.marks.binesInstallation);
  const stamp = nowStamp();
  setProp(v, 'DTSTAMP', stamp);
  setProp(v, 'LAST-MODIFIED', stamp);
};

const alarm = (action: 'DISPLAY' | 'EMAIL', minutes: number, title: string, ownEmail: string | null): Component => ({
  name: 'VALARM',
  props: [
    { name: 'ACTION', params: {}, value: action },
    { name: 'TRIGGER', params: {}, value: `-PT${minutes}M` },
    { name: 'DESCRIPTION', params: {}, value: escapeText(title) },
    ...(action === 'EMAIL'
      ? [
          { name: 'SUMMARY', params: {}, value: escapeText(title) },
          { name: 'ATTENDEE', params: {}, value: `mailto:${ownEmail}` },
        ]
      : []),
  ],
  children: [],
});

/** A new calendar resource for one event. */
export const newEventIcal = (uid: string, d: EventData, opts: WriteOpts, ownEmail: string | null): string => {
  const v: Component = {
    name: 'VEVENT',
    props: [
      { name: 'UID', params: {}, value: uid },
      { name: 'CREATED', params: {}, value: nowStamp() },
      { name: 'SEQUENCE', params: {}, value: '0' },
    ],
    children: [],
  };
  applyData(v, d, opts, ownEmail);
  if (opts.reminders) {
    if (opts.reminders.popup !== null) v.children.push(alarm('DISPLAY', opts.reminders.popup, d.title, ownEmail));
    if (opts.reminders.email !== null && ownEmail)
      v.children.push(alarm('EMAIL', opts.reminders.email, d.title, ownEmail));
  }
  return serializeIcal({
    name: 'VCALENDAR',
    props: [
      { name: 'VERSION', params: {}, value: '2.0' },
      { name: 'PRODID', params: {}, value: PRODID },
      { name: 'CALSCALE', params: {}, value: 'GREGORIAN' },
    ],
    children: [v],
  });
};

const bumpSequence = (v: Component) => setProp(v, 'SEQUENCE', String((Number(prop(v, 'SEQUENCE')?.value) || 0) + 1));

/**
 * An existing resource with one event changed: the master (key null) or one instance (an override is added when
 * there is none). Everything the sync does not manage (alarms, other properties, guests' answers) is kept.
 */
export const updateEventIcal = (
  body: string,
  key: string | null,
  d: EventData,
  opts: WriteOpts,
  ownEmail: string | null,
): string | null => {
  const cal = parseIcal(body).find((c) => c.name === 'VCALENDAR');
  if (!cal) return null;
  const zones = zonesOf(cal);
  const vevents = cal.children.filter((c) => c.name === 'VEVENT');
  const master = vevents.find((v) => !prop(v, 'RECURRENCE-ID'));
  let target = key
    ? vevents.find((v) => recurrenceKey(prop(v, 'RECURRENCE-ID'), zones) === key)
    : (master ?? vevents[0]);
  if (!target && key && master) {
    target = {
      name: 'VEVENT',
      props: master.props
        .filter((p) => !['RRULE', 'RDATE', 'EXDATE', 'DTSTART', 'DTEND', 'DURATION'].includes(p.name))
        .map((p) => ({ ...p, params: { ...p.params } })),
      children: [],
    };
    setProp(target, 'RECURRENCE-ID', key, key.length === 8 ? { VALUE: 'DATE' } : {});
    cal.children.push(target);
  }
  if (!target) return null;
  applyData(target, d, opts, ownEmail);
  bumpSequence(target);
  return serializeIcal(cal);
};

/** A series with one instance taken out (EXDATE on the master, its override removed). */
export const excludeInstanceIcal = (body: string, key: string): string | null => {
  const cal = parseIcal(body).find((c) => c.name === 'VCALENDAR');
  if (!cal) return null;
  const zones = zonesOf(cal);
  const master = cal.children.find((c) => c.name === 'VEVENT' && !prop(c, 'RECURRENCE-ID'));
  if (!master) return null;
  cal.children = cal.children.filter(
    (c) => !(c.name === 'VEVENT' && recurrenceKey(prop(c, 'RECURRENCE-ID'), zones) === key),
  );
  master.props.push({ name: 'EXDATE', params: key.length === 8 ? { VALUE: 'DATE' } : {}, value: key });
  bumpSequence(master);
  setProp(master, 'DTSTAMP', nowStamp());
  return serializeIcal(cal);
};
