// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  applyTimerDefaults,
  normalizeRecipe,
  recipeSchema,
  recipeText,
  t,
  validateRecipe,
  type Action,
  type MessageKey,
  type SentenceBoard,
} from '../src';

/** Plan — "whose timer" on start / stop time tracking. */
const board: SentenceBoard & {
  columns: { key: string; title: string; type: string; settings: Record<string, unknown> }[];
} = {
  columns: [
    { key: 'name', title: 'Name', type: 'name', settings: {} },
    { key: 'status', title: 'Status', type: 'status', settings: {} },
    { key: 'owner', title: 'Owner', type: 'people', settings: {} },
    { key: 'time', title: 'Time', type: 'time_tracking', settings: {} },
  ],
  groups: [{ id: 'g1', title: 'Group' }],
  personName: (id) => (id === 'USER000000000001' ? 'Dani' : undefined),
};
const rb = { columns: board.columns, groups: board.groups };
const trigger = { type: 'status_changed', column: 'status', labels: 'any' } as const;
const recipe = (action: Record<string, unknown>) =>
  recipeSchema.parse({ trigger, actions: [{ type: 'start_time_tracking', column: 'time', ...action }] });
const slot = (a: Action, field: string, locale: 'he' | 'en' = 'en') =>
  actionSentence(a, 0, board, locale).find((p) => p.slot === `actions.0.${field}`)?.text;

describe('whose timer: schema and defaults', () => {
  it('accepts every option; @all only on stop; unset stays unset (legacy = the owner)', () => {
    for (const who of ['@actor', '@automation_owner', 'column:owner', 'user:USER000000000001'])
      expect(recipe({ who }).actions[0]).toMatchObject({ who });
    expect(recipe({}).actions[0]).not.toHaveProperty('who');
    expect(() => recipe({ who: '@all' })).toThrow();
    expect(
      recipeSchema.parse({ trigger, actions: [{ type: 'stop_time_tracking', column: 'time', who: '@all' }] })
        .actions[0],
    ).toMatchObject({ who: '@all' });
    expect(() => recipe({ who: '@board_owners' })).toThrow();
  });

  it('new timer actions default to @actor; ones already saved without it keep the owner', () => {
    const raw = {
      trigger,
      actions: [
        { type: 'start_time_tracking', column: 'time' },
        { type: 'stop_time_tracking', column: 'time' },
        { type: 'time_tracking_start', column: 'time2' },
        { type: 'start_time_tracking', column: 'time3', who: 'column:owner' },
        { type: 'notify', to: '@actor', message: 'x' },
      ],
    };
    const fresh = applyTimerDefaults(raw) as { actions: Record<string, unknown>[] };
    expect(fresh.actions.map((a) => a.who)).toEqual(['@actor', '@actor', '@actor', 'column:owner', undefined]);
    const previous = { actions: [{ type: 'start_time_tracking', column: 'time' }] };
    const updated = applyTimerDefaults(raw, previous) as { actions: Record<string, unknown>[] };
    expect(updated.actions.map((a) => a.who)).toEqual([undefined, '@actor', '@actor', 'column:owner', undefined]);
  });

  it('the seed shorthands keep who / fallback', () => {
    const r = normalizeRecipe(
      {
        trigger,
        actions: [{ type: 'time_tracking_start', column: 'time', who: '@actor', fallback: 'column:owner' }],
      },
      { columns: board.columns },
    );
    expect(r.ok && r.recipe.actions[0]).toEqual({
      type: 'start_time_tracking',
      column: 'time',
      who: '@actor',
      fallback: 'column:owner',
    });
  });

  it('validation: who / fallback must be a people column; a clock trigger with @actor and no fallback warns', () => {
    expect(validateRecipe(recipe({ who: 'column:owner', fallback: 'column:owner' }), rb).errors).toEqual([]);
    expect(validateRecipe(recipe({ who: 'column:status' }), rb).errors[0]).toMatchObject({
      path: 'actions.0.who',
      code: 'column_type',
    });
    expect(validateRecipe(recipe({ who: '@actor', fallback: 'column:nope' }), rb).errors[0]).toMatchObject({
      path: 'actions.0.fallback',
      code: 'column_not_found',
    });
    const clock = recipeSchema.parse({
      trigger: { type: 'every_time_period', period: 'day', time: '09:00' },
      actions: [{ type: 'start_time_tracking', column: 'time', who: '@actor' }],
    });
    expect(validateRecipe(clock, rb).warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'actions.0.who', code: 'timer_no_actor' })]),
    );
  });
});

describe('whose timer: the readable sentence', () => {
  it('states whose timer, in English and Hebrew', () => {
    const owner = t('auto.who.automation_owner' as MessageKey, undefined, 'en');
    expect(slot(recipe({}).actions[0]!, 'who')).toBe(owner);
    expect(slot(recipe({ who: '@automation_owner' }).actions[0]!, 'who')).toBe(owner);
    expect(slot(recipe({ who: '@actor' }).actions[0]!, 'who')).toBe('whoever made the change');
    expect(slot(recipe({ who: '@actor' }).actions[0]!, 'who', 'he')).toBe('מי שביצע את השינוי');
    expect(slot(recipe({ who: 'column:owner' }).actions[0]!, 'who')).toBe('Owner');
    expect(slot(recipe({ who: 'user:USER000000000001' }).actions[0]!, 'who')).toBe('Dani');
    const stopAll = recipeSchema.parse({
      trigger,
      actions: [{ type: 'stop_time_tracking', column: 'time', who: '@all' }],
    }).actions[0]!;
    expect(slot(stopAll, 'who')).toBe('everyone');
    expect(slot(stopAll, 'who', 'he')).toBe('כולם');
    expect(recipeText(recipe({ who: '@actor' }), board, 'en')).toContain('whoever made the change');
    expect(recipeText(recipe({ who: '@actor' }), board, 'he')).toContain('מי שביצע את השינוי');
  });

  it('@actor shows its fallback (a people column, or skip) as a blank of its own; other options do not', () => {
    expect(slot(recipe({ who: '@actor', fallback: 'column:owner' }).actions[0]!, 'fallback')).toBe('Owner');
    expect(slot(recipe({ who: '@actor' }).actions[0]!, 'fallback')).toBe(
      t('auto.timer.skip' as MessageKey, undefined, 'en'),
    );
    expect(slot(recipe({ who: 'column:owner' }).actions[0]!, 'fallback')).toBeUndefined();
    expect(slot(recipe({}).actions[0]!, 'column')).toBe('Time');
  });
});
