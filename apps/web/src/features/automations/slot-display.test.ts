// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { t } from '@bines/shared';
import {
  peopleText,
  previewFieldText,
  slotDisplay,
  templateSegments,
  valueText,
  type DisplayEnv,
} from './slot-display';

const labels = [
  { id: 0, index: 0, label: 'Working', color: 'yellow' },
  { id: 1, index: 1, label: 'Blocked', color: 'crimson' },
];
const env: DisplayEnv = {
  // A subitem trigger: the run item is a subitem — its columns are the sub-board's.
  itemColumns: [
    { id: 'name', title: 'Subitem', type: 'name' },
    { id: 'multiple_person_mm6xcqj9', title: 'Owner', type: 'people' },
    { id: 's_status', title: 'Sub status', type: 'status', settings: { labels } },
  ],
  parentColumns: [{ id: 'status', title: 'Status', type: 'status', settings: { labels } }],
  subColumns: [
    { id: 'multiple_person_mm6xcqj9', title: 'Owner', type: 'people' },
    { id: 's_status', title: 'Sub status', type: 'status', settings: { labels } },
  ],
  mainColumns: [
    { id: 'status', title: 'Status', type: 'status', settings: { labels } },
    { id: 'due', title: 'Due', type: 'date' },
  ],
  groups: [{ id: 'g1', title: 'Active' }],
  personName: (id) => (id === 'u1' ? 'Dana' : undefined),
};

const segText = (segs: ReturnType<typeof templateSegments> | null) =>
  (segs ?? []).map((s) => ('chip' in s ? `[${s.chip}]` : s.text)).join('');

describe('r18board 5: the automation sentence reads names, not raw values', () => {
  it('a people column of the subitem by its title ("multiple_person_mm6xcqj9")', () => {
    expect(peopleText('column:multiple_person_mm6xcqj9', env)).toBe('Owner');
    expect(segText(slotDisplay({ type: 'notify', to: 'column:multiple_person_mm6xcqj9' }, 'to', env))).toBe('Owner');
    expect(peopleText(['user:u1', 'column:status'], env)).toBe('Dana, Status');
    expect(peopleText('@actor', env)).toBe(t('auto.who.actor'));
  });

  it('variables in texts as named chips', () => {
    const segs = templateSegments('Task {item.name} is {item.s_status} ({parent.status}) on {board.name}', env);
    expect(segs.filter((s) => 'chip' in s).map((s) => ('chip' in s ? s.raw : ''))).toEqual([
      '{item.name}',
      '{item.s_status}',
      '{parent.status}',
      '{board.name}',
    ]);
    expect(segText(segs)).toContain('[Sub status]');
    expect(segText(segs)).toContain(`[${t('auto.var.parent')} › Status]`);
    expect(segText(segs)).toContain(`[${t('auto.var.board')}]`);
    // Unknown keys stay as written.
    expect(segText(templateSegments('x {item.nope} y', env))).toBe('x {item.nope} y');
  });

  it('status labels by name, people by name, dates formatted, groups and columns by title', () => {
    const status = env.mainColumns[0];
    expect(valueText(1, status, env)).toBe('Blocked');
    expect(valueText({ index: 0 }, status, env)).toBe('Working');
    expect(valueText({ label: 'Blocked' }, status, env)).toBe('Blocked');
    expect(valueText({ persons_and_teams: [{ id: 'u1', kind: 'person' }] }, undefined, env)).toBe('Dana');
    expect(valueText({ date: '2026-10-07' }, env.mainColumns[1], env)).toMatch(/2026/);
    expect(valueText({ date: '2026-10-07' }, env.mainColumns[1], env)).not.toContain('{');
    expect(segText(slotDisplay({ type: 'set_column', column: 'status', value: { index: 1 } }, 'value', env))).toBe(
      'Blocked',
    );
    expect(segText(slotDisplay({ type: 'move_to_group', group: 'g1' }, 'group', env))).toBe('Active');
    expect(segText(slotDisplay({ type: 'set_status', column: 's_status' }, 'column', env))).toBe('Sub status');
    // Nothing to say: the shared sentence's own text stays.
    expect(slotDisplay({ type: 'notify' }, 'to', env)).toBeNull();
    expect(slotDisplay({ type: 'set_date', column: 'due', value: 'today+1d' }, 'value', env)).toBeNull();
  });

  it('a long text is clipped, its chips kept whole', () => {
    const long = `${'a'.repeat(30)} {item.s_status} ${'b'.repeat(40)}`;
    const out = segText(slotDisplay({ type: 'notify', message: long }, 'message', env));
    expect(out).toContain('[Sub status]');
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('r27: "run a test" preview reads names, not raw ids', () => {
  it('a group id by its name, people refs by name, columns by title, labels in words', () => {
    expect(previewFieldText({ type: 'move_to_group', group: 'g1' }, 'group', env)).toBe('Active');
    expect(previewFieldText({ type: 'notify', to: '@board_owners', message: 'hi' }, 'to', env)).toBe(
      t('auto.who.board_owners'),
    );
    expect(previewFieldText({ type: 'notify', to: ['column:multiple_person_mm6xcqj9', 'user:u1'] }, 'to', env)).toBe(
      'Owner, Dana',
    );
    expect(previewFieldText({ type: 'set_status', column: 'status', label: '1' }, 'column', env)).toBe('Status');
    expect(previewFieldText({ type: 'set_status', column: 'status', label: '1' }, 'label', env)).toBe('Blocked');
    expect(previewFieldText({ type: 'notify', message: 'Task X is done' }, 'message', env)).toBe('Task X is done');
    expect(
      previewFieldText({ type: 'create_item', board: 'b2' }, 'board', env, undefined, (id) =>
        id === 'b2' ? 'Leads' : undefined,
      ),
    ).toBe('Leads');
  });

  it('an unknown group keeps its id (another board), never an empty field', () => {
    expect(previewFieldText({ type: 'create_item', group: 'gx' }, 'group', env)).toBe('gx');
  });
});
