// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  eventsOfResource,
  excludeInstanceIcal,
  foldLine,
  newEventIcal,
  parseIcal,
  serializeIcal,
  updateEventIcal,
} from '../src/ical';
import type { EventData, WriteOpts } from '../src/provider';
import { ics } from './fake-caldav';

const unfold = (s: string) => s.replace(/\r\n[ \t]/g, '');
const one = (body: string, own: string | null = null) => eventsOfResource(body, '/c/e.ics', own)[0]!;
const opts: WriteOpts = {
  marks: { binesItemId: 'it1', binesInstallation: 'inst1' },
  timezone: 'Asia/Jerusalem',
  sendUpdates: 'all',
};
const data = (over: Partial<EventData> = {}): EventData => ({
  title: 'Meeting',
  description: null,
  location: null,
  when: { kind: 'timed', start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z' },
  attendees: null,
  ...over,
});

describe('iCalendar text', () => {
  it('unfolds, unescapes, and writes back folded at 75 octets (Hebrew counted in bytes)', () => {
    const body = ics(
      'UID:x',
      'SUMMARY:שלום\\, עולם\\; שורה\\nשנייה',
      'DESCRIPTION:a lo',
      ' ng line',
      'DTSTART:20261110T080000Z',
    );
    const ev = one(body);
    expect(ev.title).toBe('שלום, עולם; שורה\nשנייה');
    expect(ev.description).toBe('a long line');
    const long = foldLine(`SUMMARY:${'א'.repeat(100)}`);
    for (const l of long.split('\r\n')) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    const cal = parseIcal(body)[0]!;
    expect(parseIcal(serializeIcal(cal))[0]).toEqual(cal);
  });
});

describe('VEVENT → event', () => {
  it('times: UTC, a TZID by IANA name (summer and winter), a floating time as UTC', () => {
    expect(one(ics('UID:x', 'DTSTART:20261110T080000Z', 'DTEND:20261110T090000Z')).when).toEqual({
      kind: 'timed',
      start: '2026-11-10T08:00:00.000Z',
      end: '2026-11-10T09:00:00.000Z',
    });
    expect(one(ics('UID:x', 'DTSTART;TZID=Asia/Jerusalem:20260710T100000', 'DURATION:PT1H30M')).when).toEqual({
      kind: 'timed',
      start: '2026-07-10T07:00:00.000Z',
      end: '2026-07-10T08:30:00.000Z',
    });
    expect(one(ics('UID:x', 'DTSTART;TZID=Asia/Jerusalem:20261210T100000')).when).toMatchObject({
      start: '2026-12-10T08:00:00.000Z',
    });
    expect(one(ics('UID:x', 'DTSTART:20261210T100000')).when).toMatchObject({ start: '2026-12-10T10:00:00.000Z' });
  });

  it('a TZID that is not an IANA name: the file’s own VTIMEZONE rules', () => {
    const body = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:W. Europe Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010101T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:x',
      'DTSTART;TZID=W. Europe Standard Time:20260710T100000',
      'DTEND;TZID=W. Europe Standard Time:20261210T100000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(one(body).when).toEqual({
      kind: 'timed',
      start: '2026-07-10T08:00:00.000Z',
      end: '2026-12-10T09:00:00.000Z',
    });
  });

  it('all day: the end date is exclusive', () => {
    expect(one(ics('UID:x', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261112')).when).toEqual({
      kind: 'allday',
      from: '2026-11-10',
      to: '2026-11-11',
    });
    expect(one(ics('UID:x', 'DTSTART;VALUE=DATE:20261110')).when).toEqual({
      kind: 'allday',
      from: '2026-11-10',
      to: '2026-11-10',
    });
  });

  it('guests and their answers (rooms left out); an invitation from someone else may not be changed', () => {
    const ev = one(
      ics(
        'UID:x',
        'DTSTART:20261110T080000Z',
        'ORGANIZER;CN=Bob:mailto:Bob@X.test',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@x.test',
        'ATTENDEE;CN="Ann, A.";PARTSTAT=TENTATIVE:mailto:ann@x.test',
        'ATTENDEE;PARTSTAT=DECLINED:mailto:carl@x.test',
        'ATTENDEE:mailto:dana@x.test',
        'ATTENDEE;CUTYPE=ROOM:mailto:room1@x.test',
        'LOCATION:Room 1',
        'URL:https://meet.google.com/abc-defg-hij',
        'X-BINES-ITEM-ID:it9',
      ),
      'ann@x.test',
    );
    expect(ev.attendees).toEqual(['ann@x.test', 'bob@x.test', 'carl@x.test', 'dana@x.test']);
    expect(ev.responses).toEqual([
      { email: 'bob@x.test', status: 'accepted', organizer: true },
      { email: 'ann@x.test', status: 'tentative', organizer: false },
      { email: 'carl@x.test', status: 'declined', organizer: false },
      { email: 'dana@x.test', status: 'needsAction', organizer: false },
    ]);
    expect(ev).toMatchObject({
      organizerEmail: 'bob@x.test',
      canEdit: false,
      location: 'Room 1',
      meetLink: 'https://meet.google.com/abc-defg-hij',
      marks: { binesItemId: 'it9' },
    });
  });

  it('a series: the master is recurring and each excluded date is a cancelled instance; lone overrides are instances', () => {
    const evs = eventsOfResource(
      ics('UID:s', 'DTSTART:20261104T070000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261105T070000Z,20261106T070000Z'),
      '/c/s.ics',
      null,
    );
    expect(evs.map((e) => [e.id, e.status, e.recurring, e.recurringEventId])).toEqual([
      ['/c/s.ics', 'confirmed', true, null],
      ['/c/s.ics#20261105T070000Z', 'cancelled', false, '/c/s.ics'],
      ['/c/s.ics#20261106T070000Z', 'cancelled', false, '/c/s.ics'],
    ]);
    const lone = eventsOfResource(
      ics('UID:s', 'RECURRENCE-ID:20261105T070000Z', 'DTSTART:20261105T090000Z'),
      '/c/i.ics',
      null,
    );
    expect(lone[0]).toMatchObject({ id: '/c/i.ics#20261105T070000Z', recurringEventId: '/c/i.ics', recurring: false });
  });
});

describe('event → VEVENT', () => {
  it('a new event: UTC times or days, the marks, reminders', () => {
    const body = unfold(
      newEventIcal(
        'u1@bines',
        data({ description: 'Line 1\nLine, 2' }),
        { ...opts, reminders: { popup: 10, email: 30 } },
        'ann@x.test',
      ),
    );
    expect(body).toContain('UID:u1@bines');
    expect(body).toContain('DTSTART:20261110T080000Z');
    expect(body).toContain('DTEND:20261110T090000Z');
    expect(body).toContain('DESCRIPTION:Line 1\\nLine\\, 2');
    expect(body).toContain('X-BINES-ITEM-ID:it1');
    expect(body).toContain('TRIGGER:-PT10M');
    expect(body).toContain('ACTION:EMAIL');
    const day = unfold(
      newEventIcal('u2', data({ when: { kind: 'allday', from: '2026-11-10', to: '2026-11-11' } }), opts, null),
    );
    expect(day).toContain('DTSTART;VALUE=DATE:20261110');
    expect(day).toContain('DTEND;VALUE=DATE:20261112');
    expect(one(day).when).toEqual({ kind: 'allday', from: '2026-11-10', to: '2026-11-11' });
  });

  it('a change keeps what the sync does not manage (alarms, answers, other properties) and bumps SEQUENCE', () => {
    const body = ics(
      'UID:x',
      'SEQUENCE:2',
      'DTSTART:20261110T080000Z',
      'SUMMARY:Old',
      'X-OTHER-APP:keep-me',
      'ORGANIZER:mailto:ann@x.test',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@x.test',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:carl@x.test',
      'ATTENDEE;CUTYPE=ROOM:mailto:room@x.test',
    );
    const next = unfold(
      updateEventIcal(
        body,
        null,
        data({ attendees: ['bob@x.test', 'dana@x.test'] }),
        { ...opts, sendUpdates: 'externalOnly' },
        'ann@x.test',
      )!,
    );
    expect(next).toContain('SUMMARY:Meeting');
    expect(next).toContain('X-OTHER-APP:keep-me');
    expect(next).toContain('SEQUENCE:3');
    expect(next).toMatch(/ATTENDEE;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:bob@x\.test/); // same domain
    expect(next).not.toContain('carl@x.test');
    expect(next).toContain('mailto:dana@x.test');
    expect(next).toContain('CUTYPE=ROOM:mailto:room@x.test');
  });

  it('one instance: an override is added (then changed); deleting one adds an EXDATE', () => {
    const series = ics('UID:s', 'DTSTART:20261104T070000Z', 'DTEND:20261104T071500Z', 'RRULE:FREQ=DAILY;COUNT=3');
    const moved = updateEventIcal(series, '20261105T070000Z', data({ title: 'Moved' }), opts, null)!;
    const cal = parseIcal(moved)[0]!;
    const vevents = cal.children.filter((c) => c.name === 'VEVENT');
    expect(vevents).toHaveLength(2);
    expect(unfold(moved)).toContain('RECURRENCE-ID:20261105T070000Z');
    const again = updateEventIcal(moved, '20261105T070000Z', data({ title: 'Again' }), opts, null)!;
    expect(parseIcal(again)[0]!.children.filter((c) => c.name === 'VEVENT')).toHaveLength(2);
    const cut = excludeInstanceIcal(again, '20261105T070000Z')!;
    expect(parseIcal(cut)[0]!.children.filter((c) => c.name === 'VEVENT')).toHaveLength(1);
    expect(cut).toContain('EXDATE:20261105T070000Z');
  });
});
