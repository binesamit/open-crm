// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  checkTransition,
  conditionFailureText,
  isOutsideWorkflow,
  moveTransition,
  movePopup,
  popupAsks,
  popupSubitemsRule,
  reachableLabels,
  subitemsPass,
  transitionPopup,
  transitionSubitemsRule,
  type StatusWorkflow,
  type WorkflowCheckCtx,
} from '../src/workflows/status-workflow';

/** the status workflow rules the server enforces and the picker reads. */
const wf: StatusWorkflow = {
  enabled: true,
  free_start: true,
  allow_clear: false,
  transitions: [
    { from: 0, to: 1 },
    { from: 1, to: 2, required: ['note'] },
    { from: null, to: 3 },
    { from: 2, to: 0, who: { users: ['u2'], teams: ['t1'] } },
  ],
};
const ctx = (over: Partial<WorkflowCheckCtx> = {}): WorkflowCheckCtx => ({
  userId: 'u1',
  teamIds: [],
  filled: () => false,
  ...over,
});

describe('checkTransition', () => {
  it('passes mapped moves, "from any" moves, a free start and no change; blocks the rest', () => {
    expect(checkTransition(wf, 0, 1, ctx()).ok).toBe(true);
    expect(checkTransition(wf, 2, 3, ctx()).ok).toBe(true);
    expect(checkTransition(wf, null, 2, ctx()).ok).toBe(true);
    expect(checkTransition(wf, 1, 1, ctx()).ok).toBe(true);
    expect(checkTransition(wf, 0, 2, ctx())).toEqual({ ok: false, block: { reason: 'not_allowed' } });
    expect(checkTransition({ ...wf, free_start: false }, null, 2, ctx()).ok).toBe(false);
  });

  it('clearing follows allow_clear; a workflow that is off passes everything', () => {
    expect(checkTransition(wf, 1, null, ctx()).ok).toBe(false);
    expect(checkTransition({ ...wf, allow_clear: true }, 1, null, ctx()).ok).toBe(true);
    expect(checkTransition({ ...wf, enabled: false }, 0, 2, ctx()).ok).toBe(true);
  });

  it('names the empty required columns; `who` by user or team; automations skip `who`', () => {
    expect(checkTransition(wf, 1, 2, ctx())).toMatchObject({
      ok: false,
      block: { reason: 'required', columns: ['note'] },
    });
    expect(checkTransition(wf, 1, 2, ctx({ filled: (k) => k === 'note' })).ok).toBe(true);
    expect(checkTransition(wf, 2, 0, ctx())).toMatchObject({ ok: false, block: { reason: 'who' } });
    expect(checkTransition(wf, 2, 0, ctx({ userId: 'u2' })).ok).toBe(true);
    expect(checkTransition(wf, 2, 0, ctx({ teamIds: ['t1'] })).ok).toBe(true);
    expect(checkTransition(wf, 2, 0, ctx({ automation: true })).ok).toBe(true);
  });

  it('checks conditions when an evaluator is given', () => {
    const cond: StatusWorkflow = {
      enabled: true,
      transitions: [
        {
          from: 0,
          to: 1,
          conditions: {
            kind: 'group',
            operator: 'and',
            negate: false,
            rules: [{ kind: 'rule', column_id: 'n', operator: 'is_not_empty', values: [], negate: false }],
          },
        },
      ],
    };
    expect(checkTransition(cond, 0, 1, ctx({ matches: () => false }))).toMatchObject({
      ok: false,
      block: { reason: 'conditions' },
    });
    expect(checkTransition(cond, 0, 1, ctx({ matches: () => true })).ok).toBe(true);
    expect(checkTransition(cond, 0, 1, ctx()).ok).toBe(true); // the picker: no evaluator
  });
});

describe('reachableLabels / isOutsideWorkflow', () => {
  it('lists the targets from a label (and itself); null on a free start', () => {
    expect([...reachableLabels(wf, 0)!].sort()).toEqual([0, 1, 3]);
    expect([...reachableLabels(wf, 2)!].sort()).toEqual([0, 2, 3]);
    expect([...reachableLabels(wf, 2, { userId: 'u1', teamIds: [] })!].sort()).toEqual([2, 3]);
    expect(reachableLabels(wf, null)).toBeNull();
  });

  it('a label no move names is outside the workflow', () => {
    expect(isOutsideWorkflow(wf, 5)).toBe(true);
    expect(isOutsideWorkflow(wf, 2)).toBe(false);
    expect(isOutsideWorkflow(wf, null)).toBe(false);
  });
});

describe('phase 2: popups', () => {
  const pop: StatusWorkflow = {
    enabled: true,
    transitions: [
      {
        from: 0,
        to: 1,
        popup: { fields: [{ column_id: 'reason', required: true }, { column_id: 'x' }], note: 'required' },
      },
      { from: null, to: 1, popup: { fields: [], note: 'optional' } },
      { from: 1, to: 2, popup: { fields: [], note: 'off' } },
    ],
  };

  it('a popup’s required fields count as the move’s; a required note needs one (not from automations)', () => {
    expect(checkTransition(pop, 0, 1, ctx()).ok).toBe(true);
    // "from any label" passes without the field (its own popup asks for an optional note only).
    const onlySpecific = { ...pop, transitions: [pop.transitions[0]!] };
    expect(checkTransition(onlySpecific, 0, 1, ctx())).toMatchObject({
      ok: false,
      block: { reason: 'required', columns: ['reason'] },
    });
    expect(checkTransition(onlySpecific, 0, 1, ctx({ filled: () => true }))).toMatchObject({
      ok: false,
      block: { reason: 'note' },
    });
    expect(checkTransition(onlySpecific, 0, 1, ctx({ filled: () => true, note: true })).ok).toBe(true);
    expect(checkTransition(onlySpecific, 0, 1, ctx({ filled: () => true, automation: true })).ok).toBe(true);
  });

  it('movePopup: the move from this label first, then from any; a popup that asks nothing opens nothing', () => {
    expect(movePopup(pop, 0, 1)?.fields).toHaveLength(2);
    expect(movePopup(pop, 2, 1)?.note).toBe('optional');
    expect(movePopup(pop, 1, 2)).toBeNull();
    expect(movePopup({ ...pop, enabled: false }, 0, 1)).toBeNull();
    expect(popupAsks({ fields: [], note: 'off' })).toBe(false);
  });
});

describe('subitems a move needs', () => {
  const sub: StatusWorkflow = {
    enabled: true,
    free_start: true,
    transitions: [{ from: 0, to: 1, subitems: { min: 2, required: ['amount'] } }],
  };
  it('counts complete subitems against the minimum and "all"', () => {
    expect(subitemsPass({ min: 2, required: [] }, { complete: 2, incomplete: 3 })).toBe(true);
    expect(subitemsPass({ min: 2, required: [] }, { complete: 1, incomplete: 0 })).toBe(false);
    expect(subitemsPass({ min: 1, required: ['a'], all: true }, { complete: 1, incomplete: 1 })).toBe(false);
    expect(subitemsPass({ min: 0, required: ['a'], all: true }, { complete: 0, incomplete: 0 })).toBe(true);
  });
  it('blocks the move with how many there are; the picker (no tally) does not check', () => {
    const r = checkTransition(sub, 0, 1, ctx({ subitems: () => ({ complete: 1, incomplete: 2 }) }));
    expect(r).toMatchObject({
      ok: false,
      block: { reason: 'subitems', min: 2, have: 1, incomplete: 2, all: false, columns: ['amount'] },
    });
    expect(checkTransition(sub, 0, 1, ctx({ subitems: () => ({ complete: 2, incomplete: 0 }) })).ok).toBe(true);
    expect(checkTransition(sub, 0, 1, ctx()).ok).toBe(true);
  });
  it('a move with a rule opens a popup that asks its columns; a popup of its own adds to the rule', () => {
    expect(movePopup(sub, 0, 1)).toEqual({
      fields: [],
      note: 'off',
      subitems: { fields: [{ column_id: 'amount', required: true }], min: 2 },
    });
    const t = {
      from: 0,
      to: 1,
      subitems: { min: 1, required: ['amount'] },
      popup: { fields: [], subitems: { fields: [{ column_id: 'name', required: true }], min: 3 } },
    };
    expect(transitionSubitemsRule(t)).toEqual({
      min: 3,
      required: ['amount', 'name'],
      all: undefined,
      conditions: undefined,
    });
    expect(transitionPopup(t)?.subitems?.fields).toEqual([
      { column_id: 'name', required: true },
      { column_id: 'amount', required: true },
    ]);
    expect(popupSubitemsRule({ fields: [], subitems: { fields: [{ column_id: 'name' }] } })).toBeNull();
  });
});

describe('conditions for the move ( round 2)', () => {
  const cond = { kind: 'group' as const, operator: 'and' as const, negate: false, rules: [] };
  const withRules: StatusWorkflow = {
    enabled: true,
    transitions: [
      {
        from: 0,
        to: 1,
        message: 'Pay first',
        conditions: {
          ...cond,
          rules: [{ kind: 'rule', column_id: 'fin', operator: 'any_of', values: ['1'], negate: false }],
        },
      },
      { from: null, to: 2, required: ['amount'] },
    ],
  };

  it('a blocked move carries its own message and names the move it came from', () => {
    const r = checkTransition(withRules, 0, 1, ctx({ matches: () => false }));
    expect(r).toMatchObject({ ok: false, block: { reason: 'conditions', message: 'Pay first' } });
    expect(r.ok ? null : r.transition?.to).toBe(1);
    expect(checkTransition(withRules, 0, 1, ctx({ matches: () => true }))).toEqual({ ok: true });
  });

  it('moveTransition picks the move from this label first, then from any label', () => {
    expect(moveTransition(withRules, 0, 1)?.message).toBe('Pay first');
    expect(moveTransition(withRules, 5, 2)?.required).toEqual(['amount']);
    expect(moveTransition(withRules, 5, 1)).toBeNull();
    expect(moveTransition({ ...withRules, enabled: false }, 0, 1)).toBeNull();
  });

  it('subitems that do not meet "each" block the move even with enough complete ones', () => {
    const rule = { min: 1, required: [], each: cond };
    expect(subitemsPass(rule, { complete: 2, incomplete: 1, failing: 1 })).toBe(false);
    expect(subitemsPass(rule, { complete: 2, incomplete: 0 })).toBe(true);
    const wfEach: StatusWorkflow = { enabled: true, transitions: [{ from: 0, to: 1, subitems: rule }] };
    const r = checkTransition(wfEach, 0, 1, ctx({ subitems: () => ({ complete: 1, incomplete: 1, failing: 1 }) }));
    expect(r).toMatchObject({ ok: false, block: { reason: 'subitems', failing: 1 } });
  });

  it('a failed condition in words, with the value now', () => {
    const base = { column_id: 'fin', title: 'Finance', values: ['Paid'] };
    expect(conditionFailureText({ ...base, operator: 'any_of', current: 'Deposit' }, 'en')).toBe(
      'Finance must be: Paid (now: Deposit)',
    );
    expect(conditionFailureText({ ...base, operator: 'any_of', negate: true, current: 'Paid' }, 'en')).toBe(
      'Finance can’t be: Paid (now: Paid)',
    );
    expect(conditionFailureText({ ...base, operator: 'is_not_empty', values: [], current: null }, 'en')).toBe(
      'Finance must be filled in (now: empty)',
    );
    expect(conditionFailureText({ ...base, operator: 'any_of' }, 'en')).toBe('Finance must be: Paid');
    expect(conditionFailureText({ ...base, operator: 'group', title: '(a or b)', values: [] }, 'en')).toBe('(a or b)');
  });
});
