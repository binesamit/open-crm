// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addedPersonRefs, TRIGGERS, whoNeedsItem, type AutomationEvent } from '../src/automations/triggers';

/** Audit 2026-10-10 — automation lows #12 (updates automations post) and #16 (`person_assigned` `who`). */
const ctx = { automationId: 'a1', columns: [{ id: 'people', type: 'people', settings: {} }] };
const people = (...ids: string[]) => ({ value: { persons_and_teams: ids.map((id) => ({ id, kind: 'person' })) } });
const ev = (over: Partial<AutomationEvent>): AutomationEvent => ({
  id: 'e1',
  type: 'cell.changed',
  board_id: 'b1',
  item_id: 'i1',
  column_key: 'people',
  column_type: 'people',
  actor: { type: 'user', id: 'u-actor' },
  ...over,
});

describe('#12 — update_posted ignores updates an automation posted', () => {
  const t = { type: 'update_posted' as const };
  const posted = (actor: AutomationEvent['actor']) =>
    ev({ type: 'update.created', column_key: null, column_type: null, update_text: 'שלום', actor });

  it('a person’s update fires; an automation run’s does not', () => {
    expect(TRIGGERS.update_posted.match(t, posted({ type: 'user', id: 'u1' }), ctx)).toBe(true);
    expect(TRIGGERS.update_posted.match(t, posted({ type: 'user', id: 'u1', automation_id: 'other' }), ctx)).toBe(
      false,
    );
    expect(TRIGGERS.update_posted.match(t, posted({ type: 'automation', id: null, automation_id: 'a9' }), ctx)).toBe(
      false,
    );
  });
});

describe('#16 — person_assigned answers `who` from the event, or hands it to the runner', () => {
  const t = (who: string) => ({ type: 'person_assigned' as const, column: 'people', who });
  const assigned = (before: string[], after: string[]) => ev({ before: people(...before), after: people(...after) });

  it('a person / team ref matches only that one; @actor only the one who made the change', () => {
    expect(TRIGGERS.person_assigned.match(t('user:u1'), assigned([], ['u1']), ctx)).toBe(true);
    expect(TRIGGERS.person_assigned.match(t('user:u1'), assigned([], ['u2']), ctx)).toBe(false);
    expect(TRIGGERS.person_assigned.match(t('user:u1'), assigned(['u1'], ['u1', 'u2']), ctx)).toBe(false);
    expect(TRIGGERS.person_assigned.match(t('@actor'), assigned([], ['u-actor']), ctx)).toBe(true);
    expect(TRIGGERS.person_assigned.match(t('@actor'), assigned([], ['u2']), ctx)).toBe(false);
    expect(TRIGGERS.person_assigned.match(t('any'), assigned([], ['u2']), ctx)).toBe(true);
    expect(TRIGGERS.person_assigned.match(t('any'), assigned(['u2'], ['u2']), ctx)).toBe(false);
  });

  it('a ref the event cannot answer is a candidate the runner finishes (deep), never a blanket match', () => {
    expect(TRIGGERS.person_assigned.deep).toBe(true);
    for (const who of ['@creator', '@board_owners', 'column:owner', 'mirror:rel.owner']) {
      expect(whoNeedsItem(who)).toBe(true);
      expect(TRIGGERS.person_assigned.match(t(who), assigned([], ['u2']), ctx)).toBe(true);
      expect(TRIGGERS.person_assigned.match(t(who), assigned(['u2'], ['u2']), ctx)).toBe(false);
    }
    for (const who of ['any', '@actor', 'user:u1', 'team:t1']) expect(whoNeedsItem(who)).toBe(false);
    expect(addedPersonRefs(people('u1'), people('u1', 'u2'))).toEqual(['user:u2']);
    expect(addedPersonRefs(undefined, { value: { persons_and_teams: [{ id: 't1', kind: 'team' }] } })).toEqual([
      'team:t1',
    ]);
  });
});

describe('security #27 — a webhook action’s extra headers are capped', () => {
  it('at most 20 headers, names ≤ 100 and values ≤ 1000 characters', async () => {
    const { actionSchema } = await import('../src/automations/schema');
    const headers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`x-h-${i}`, 'v']));
    expect(actionSchema.safeParse({ type: 'webhook', url: 'https://x.example', headers: headers(20) }).success).toBe(
      true,
    );
    expect(actionSchema.safeParse({ type: 'webhook', url: 'https://x.example', headers: headers(21) }).success).toBe(
      false,
    );
    expect(
      actionSchema.safeParse({ type: 'webhook', url: 'https://x.example', headers: { 'x-a': 'v'.repeat(1001) } })
        .success,
    ).toBe(false);
  });
});
