// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { newItemFromEvent, renderTemplate, templateVars } from '../src/mapping';
import type { ProviderEvent } from '../src/provider';
import { config } from './fakes';

const ev: ProviderEvent = {
  id: 'g1',
  status: 'confirmed',
  updated: '2026-11-03T08:00:00Z',
  created: '2026-11-03T08:00:00Z',
  title: 'Design review',
  description: 'Bring the mock-ups',
  location: 'Room 4',
  meetLink: 'https://meet.google.com/xyz',
  organizerEmail: 'lead@x.test',
  attendees: ['ann@x.test', 'guest@out.test'],
  responses: [],
  when: { kind: 'timed', start: '2026-11-10T07:00:00Z', end: '2026-11-10T08:00:00Z' },
  recurring: false,
  recurringEventId: null,
  icalUid: 'g1@ical',
  canEdit: true,
  marks: {},
};

describe('templates', () => {
  it('fills {{variables}} (spaces allowed); unknown ones become empty', () => {
    expect(renderTemplate('{{ title }} @ {{location}} {{nope}}', templateVars(ev))).toBe('Design review @ Room 4');
    expect(renderTemplate('{{meet_link}}', templateVars(ev))).toBe('https://meet.google.com/xyz');
    expect(renderTemplate('by {{organizer}} with {{attendees}}', templateVars(ev))).toBe(
      'by lead@x.test with ann@x.test, guest@out.test',
    );
    expect(renderTemplate('{{calendar}}', templateVars(ev, 'Team'))).toBe('Team');
  });

  it('a new event → the item: name, group, fields as values, time cells, people by email (owner first)', () => {
    const cfg = config({
      template: {
        name: 'פגישה: {{title}}',
        group_id: 'g_new',
        fields: [
          { column_id: 'notes', template: '{{description}}\n{{location}}' },
          { column_id: 'link', template: '{{meet_link}}' },
          { column_id: 'empty', template: '{{nope}}' },
        ],
      },
    });
    expect(newItemFromEvent(ev, cfg, { ownerEmail: 'bob@x.test' })).toEqual({
      name: 'פגישה: Design review',
      group_id: 'g_new',
      cells: { tl: { from: '2026-11-10', to: '2026-11-10', from_time: '09:00', to_time: '10:00' } },
      values: {
        notes: 'Bring the mock-ups\nRoom 4',
        link: 'https://meet.google.com/xyz',
        people: 'bob@x.test, ann@x.test, guest@out.test',
      },
    });
  });

  it('an empty rendered name falls back to the title', () => {
    expect(newItemFromEvent(ev, config({ template: { name: '{{nope}}' } }))?.name).toBe('Design review');
  });
});
