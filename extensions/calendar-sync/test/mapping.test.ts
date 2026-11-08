// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { fromGoogle, mergeAttendees, toGoogle } from '../src/google';
import {
  aggregateRsvp,
  hashEvent,
  itemToEvent,
  itemWhen,
  providerEventData,
  rsvpLabel,
  whenCells,
  type BinesItem,
} from '../src/mapping';
import { withDefaults, type SyncConfig } from '../src/config';
import { config } from './fakes';

const item = (cells: BinesItem['cells'], name = 'Kickoff'): BinesItem => ({
  id: 'i1',
  board_id: 'b1',
  name,
  updated_at: '2026-11-03T08:00:00Z',
  cells,
});

describe('item → event (the core calendar helpers)', () => {
  it('a timeline with hours: wall-clock in the account zone → instants', () => {
    const cfg = config();
    const w = itemWhen(
      { tl: { value: { from: '2026-11-10', to: '2026-11-10', from_time: '09:30', to_time: '11:00' } } },
      cfg,
    );
    // Israel is UTC+2 in November.
    expect(w).toEqual({ kind: 'timed', start: '2026-11-10T07:30:00.000Z', end: '2026-11-10T09:00:00.000Z' });
  });

  it('a timeline without hours is all-day (inclusive days)', () => {
    expect(itemWhen({ tl: { value: { from: '2026-11-10', to: '2026-11-12' } } }, config())).toEqual({
      kind: 'allday',
      from: '2026-11-10',
      to: '2026-11-12',
    });
  });

  it('a date + start / end hour columns (the date_hours source)', () => {
    const cfg = config({ time_source: 'date_hours', date_column_id: 'd', start_column_id: 'sh', end_column_id: 'eh' });
    const cells = {
      d: { value: { date: '2026-11-10' } },
      sh: { value: { hour: 22, minute: 0 } },
      eh: { value: { hour: 1, minute: 0 } },
    };
    // An end before the start is the next day.
    expect(itemWhen(cells, cfg)).toEqual({
      kind: 'timed',
      start: '2026-11-10T20:00:00.000Z',
      end: '2026-11-10T23:00:00.000Z',
    });
    // No end column value: the default length.
    expect(itemWhen({ ...cells, eh: undefined }, cfg)).toMatchObject({ end: '2026-11-10T21:00:00.000Z' });
    // A date with nothing else: all-day.
    expect(itemWhen({ d: { value: { date: '2026-11-10' } } }, cfg)).toEqual({
      kind: 'allday',
      from: '2026-11-10',
      to: '2026-11-10',
    });
  });

  it('no date → no event', () => {
    expect(itemToEvent(item({}), config())).toBeNull();
  });

  it('description / location go back only from a column whose template is exactly that variable', () => {
    const cfg = config({
      template: {
        fields: [
          { column_id: 'notes', template: '{{description}}' },
          { column_id: 'where', template: 'At {{location}}' },
        ],
      },
    });
    const ev = itemToEvent(
      item({
        tl: { value: { from: '2026-11-10', to: '2026-11-10' } },
        notes: { value: null, text: 'Agenda' },
        where: { value: null, text: 'Room 1' },
      }),
      cfg,
    );
    expect(ev).toMatchObject({ title: 'Kickoff', description: 'Agenda', location: null, attendees: null });
  });

  it('attendees (invitations on): the people by email plus the email column, sorted, once each', () => {
    const cfg = config({ attendees: { enabled: true, email_column_id: 'guests' } });
    const ev = itemToEvent(
      item({
        tl: { value: { from: '2026-11-10', to: '2026-11-10' } },
        people: {
          value: {
            persons_and_teams: [
              { id: 'u2', kind: 'person' },
              { id: 't1', kind: 'team' },
            ],
          },
        },
        guests: { value: null, text: 'Zed@Out.test, bob@x.test; nope' },
      }),
      cfg,
      (id) => (id === 'u2' ? 'bob@x.test' : null),
    );
    expect(ev?.attendees).toEqual(['bob@x.test', 'zed@out.test']);
  });
});

describe('event → cells', () => {
  it('a timed event writes the timeline with wall-clock hours (round trip)', () => {
    const cfg = config();
    const when = { kind: 'timed' as const, start: '2026-11-10T07:30:00Z', end: '2026-11-10T09:00:00Z' };
    const cells = whenCells(when, cfg);
    expect(cells).toEqual({ tl: { from: '2026-11-10', to: '2026-11-10', from_time: '09:30', to_time: '11:00' } });
    expect(itemWhen({ tl: { value: cells.tl } }, cfg)).toEqual({
      kind: 'timed',
      start: '2026-11-10T07:30:00.000Z',
      end: '2026-11-10T09:00:00.000Z',
    });
  });

  it('a timed event on the date_hours source writes the date and the hour columns', () => {
    const cfg = config({ time_source: 'date_hours', date_column_id: 'd', start_column_id: 'sh', end_column_id: 'eh' });
    expect(whenCells({ kind: 'timed', start: '2026-11-10T07:30:00Z', end: '2026-11-10T09:00:00Z' }, cfg)).toEqual({
      d: { date: '2026-11-10' },
      sh: { hour: 9, minute: 30 },
      eh: { hour: 11, minute: 0 },
    });
  });

  it('an all-day event: a timeline range, or a date without hours', () => {
    expect(whenCells({ kind: 'allday', from: '2026-11-10', to: '2026-11-11' }, config())).toEqual({
      tl: { from: '2026-11-10', to: '2026-11-11' },
    });
    const cfg = config({ time_source: 'date_hours', date_column_id: 'd', start_column_id: 'sh', end_column_id: 'eh' });
    expect(whenCells({ kind: 'allday', from: '2026-11-10', to: '2026-11-10' }, cfg)).toEqual({
      d: { date: '2026-11-10' },
      sh: null,
      eh: null,
    });
  });
});

describe('Google shapes', () => {
  it('all-day end is exclusive on Google, inclusive here', () => {
    const g = fromGoogle({ id: 'e', start: { date: '2026-11-10' }, end: { date: '2026-11-12' } });
    expect(g.when).toEqual({ kind: 'allday', from: '2026-11-10', to: '2026-11-11' });
    const body = toGoogle(
      { title: 'x', description: null, location: null, when: g.when!, attendees: null },
      { marks: { binesItemId: 'i1', binesInstallation: 'in' }, timezone: 'Asia/Jerusalem' },
    );
    expect(body).toMatchObject({ start: { date: '2026-11-10' }, end: { date: '2026-11-12' } });
    expect(body.extendedProperties).toEqual({ private: { binesItemId: 'i1', binesInstallation: 'in' } });
  });

  it('reads answers, the Meet link, and whether this copy may be changed', () => {
    const g = fromGoogle({
      id: 'e',
      start: { dateTime: '2026-11-10T09:30:00+02:00' },
      end: { dateTime: '2026-11-10T10:00:00+02:00' },
      hangoutLink: 'https://meet.google.com/abc',
      organizer: { email: 'a@x.test', self: false },
      attendees: [
        { email: 'A@x.test', organizer: true, responseStatus: 'accepted' },
        { email: 'b@x.test', responseStatus: 'declined' },
        { email: 'room@x.test', resource: true },
      ],
    });
    expect(g.when).toEqual({ kind: 'timed', start: '2026-11-10T07:30:00.000Z', end: '2026-11-10T08:00:00.000Z' });
    expect(g.attendees).toEqual(['a@x.test', 'b@x.test']);
    expect(g.responses[1]).toEqual({ email: 'b@x.test', status: 'declined', organizer: false });
    expect(g.meetLink).toBe('https://meet.google.com/abc');
    expect(g.canEdit).toBe(false);
  });

  it('attendee changes keep the answers of those who stay (and rooms)', () => {
    const merged = mergeAttendees(
      ['a@x.test', 'c@x.test'],
      [
        { email: 'a@x.test', responseStatus: 'accepted' },
        { email: 'b@x.test', responseStatus: 'declined' },
        { email: 'room@x.test', resource: true },
      ],
    );
    expect(merged).toEqual([
      { email: 'a@x.test', responseStatus: 'accepted' },
      { email: 'c@x.test' },
      { email: 'room@x.test', resource: true },
    ]);
  });

  it('the fingerprint is the same from both sides for the same meeting', () => {
    const cfg = config();
    const fromItem = itemToEvent(
      item({ tl: { value: { from: '2026-11-10', to: '2026-11-10', from_time: '09:30', to_time: '11:00' } } }),
      cfg,
    );
    const g = fromGoogle({
      id: 'e',
      summary: 'Kickoff',
      start: { dateTime: '2026-11-10T09:30:00+02:00' },
      end: { dateTime: '2026-11-10T11:00:00+02:00' },
      description: 'ignored: not mapped',
    });
    expect(hashEvent(providerEventData(g, cfg))).toBe(hashEvent(fromItem));
  });
});

describe('answers (RSVP) aggregate', () => {
  const a = (status: 'accepted' | 'declined' | 'tentative' | 'needsAction', organizer = false) => ({
    email: `${status}${organizer}@x.test`,
    status,
    organizer,
  });
  it('any declined → declined; all accepted → accepted; any maybe → tentative; else pending; organizer not counted', () => {
    expect(aggregateRsvp([a('accepted'), a('accepted')])).toBe('accepted');
    expect(aggregateRsvp([a('accepted'), a('declined'), a('tentative')])).toBe('declined');
    expect(aggregateRsvp([a('accepted'), a('tentative')])).toBe('tentative');
    expect(aggregateRsvp([a('accepted'), a('needsAction')])).toBe('pending');
    expect(aggregateRsvp([a('needsAction', true), a('accepted')])).toBe('accepted');
    expect(aggregateRsvp([a('accepted', true)])).toBeNull();
  });
  it('labels: tentative falls back to pending', () => {
    const cfg = config({ rsvp: { column_id: 's', labels: { accepted: 'A', declined: 'B', pending: 'C' } } });
    expect(rsvpLabel(cfg, 'accepted')).toBe('A');
    expect(rsvpLabel(cfg, 'declined')).toBe('B');
    expect(rsvpLabel(cfg, 'tentative')).toBe('C');
    expect(rsvpLabel(cfg, null)).toBe('');
  });
});

describe('a config saved by an older version', () => {
  it('gets the settings added since as their defaults (a missing no_people = creator)', () => {
    const { no_people: _gone, ...old } = config();
    const read = withDefaults(old as SyncConfig)!;
    expect(read.no_people).toBe('creator');
    expect(read.board_id).toBe(old.board_id);
  });
});
