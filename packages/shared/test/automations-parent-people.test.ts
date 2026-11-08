// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { recipeSchema, recipeText, scopedSentenceBoard, peopleRefText, validateRecipe, type RecipeBoard } from '../src';

/**
 * a subitem trigger whose recipients are a people column of the PARENT's board — save-time checks
 * and the sentence ("<column> of <board>").
 */
const col = (key: string, title: string, type: string) => ({ key, title, type, settings: {} });
const board: RecipeBoard = {
  columns: [
    col('name', 'Name', 'name'),
    col('manager', 'מנהל', 'people'),
    col('client_mail', 'Client email', 'email'),
    col('budget', 'Budget', 'numbers'),
  ],
  groups: [{ id: 'g1', title: 'Group' }],
  subColumns: [col('name', 'Name', 'name'), col('owner', 'Owner', 'people'), col('status', 'Status', 'status')],
};
const subTrigger = recipeSchema.parse({
  trigger: { type: 'subitem_status_changed', column: 'status', labels: 'any' },
  actions: [{ type: 'notify', to: '@actor', message: 'x' }],
}).trigger;
const recipe = (actions: Record<string, unknown>[], trigger: Record<string, unknown> = subTrigger) =>
  recipeSchema.parse({ trigger, actions });
const errorsOf = (actions: Record<string, unknown>[], trigger?: Record<string, unknown>) =>
  validateRecipe(recipe(actions, trigger), board).errors;

describe('people refs: the parent board for subitem triggers', () => {
  it('accepts the subitem’s and the parent’s people columns (notify, assign, send_email, timers)', () => {
    expect(
      errorsOf([
        { type: 'notify', to: 'column:manager', message: 'x' },
        { type: 'notify', to: ['column:owner', 'column:manager', '@actor'], message: 'x' },
        { type: 'send_email', to: ['column:manager', 'column:client_mail'], subject: 's', body_html: 'b' },
        { type: 'assign', column: 'owner', who: 'column:manager' },
        { type: 'unassign', column: 'owner', who: 'column:manager' },
        { type: 'stop_time_tracking', column: 'owner', who: '@actor', fallback: 'column:manager' },
      ]).filter((e) => !e.path.endsWith('.column')),
    ).toEqual([]);
  });

  it('refuses a column on neither board, and a column that is not a people column', () => {
    expect(errorsOf([{ type: 'notify', to: 'column:nope', message: 'x' }])).toEqual([
      { path: 'actions.0.to', code: 'column_not_found', detail: 'nope' },
    ]);
    expect(errorsOf([{ type: 'notify', to: ['@actor', 'column:budget'], message: 'x' }])).toEqual([
      { path: 'actions.0.to.1', code: 'not_a_people_column', detail: 'numbers' },
    ]);
    // An email column is a recipient of an email, not of a notification.
    expect(errorsOf([{ type: 'notify', to: 'column:client_mail', message: 'x' }])[0]).toMatchObject({
      code: 'not_a_people_column',
    });
    expect(errorsOf([{ type: 'send_email', to: 'column:budget', subject: 's', body_html: 'b' }])[0]).toMatchObject({
      path: 'actions.0.to',
      code: 'not_a_people_column',
    });
    expect(errorsOf([{ type: 'assign', column: 'owner', who: 'column:status' }])[0]).toMatchObject({
      path: 'actions.0.who',
      code: 'not_a_people_column',
    });
  });

  it('a board trigger cannot reach the sub-board’s people columns (no parent there)', () => {
    expect(
      errorsOf([{ type: 'notify', to: 'column:owner', message: 'x' }], {
        type: 'status_changed',
        column: 'budget',
        labels: 'any',
      }),
    ).toEqual(expect.arrayContaining([{ path: 'actions.0.to', code: 'column_not_found', detail: 'owner' }]));
  });

  it('the sentence names the parent’s column with the parent board’s name', () => {
    const sb = scopedSentenceBoard({ ...board, parentBoardName: 'Projects' }, subTrigger);
    const parentText = peopleRefText('column:manager', sb, 'he');
    expect(parentText).toContain('מנהל');
    expect(parentText).toContain('Projects');
    // The subitem's own column reads as before.
    expect(peopleRefText('column:owner', sb, 'en')).toBe('Owner');
    // Without the board's name: still says it is the parent's.
    const noName = peopleRefText('column:manager', scopedSentenceBoard(board, subTrigger), 'he');
    expect(noName).toContain('מנהל');
    expect(noName).not.toBe('מנהל');
    const line = recipeText(recipe([{ type: 'notify', to: 'column:manager', message: 'x' }]), {
      ...board,
      parentBoardName: 'Projects',
    });
    expect(line).toContain(parentText);
  });
});
