// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseRunReason, runReasonText } from './run-reasons';

describe('run skip reasons (r16name)', () => {
  it('splits a timer action reason per person', () => {
    expect(parseRunReason('guest: Dana; no_edit_rights: Ron Levi')).toEqual([
      { code: 'guest', name: 'Dana' },
      { code: 'no_edit_rights', name: 'Ron Levi' },
    ]);
    expect(parseRunReason('not_running')).toEqual([{ code: 'not_running' }]);
    expect(parseRunReason(null)).toEqual([]);
  });

  it('reads known run codes and keeps unknown ones as written', () => {
    // `auto.runs.skip.conditions` is in he.json today.
    expect(runReasonText('conditions')).not.toBe('conditions');
    expect(runReasonText('some_new_code: Dana')).toBe('some_new_code: Dana');
  });
});

describe('item template skips (phase 2)', () => {
  it('reads the template codes, naming the questions with no answer', () => {
    expect(runReasonText('missing_variables: תאריך התחלה')).toBe(`${runReasonText('missing_variables')}: תאריך התחלה`);
    for (const code of ['missing_variables', 'too_deep', 'template_has_no_subitems'])
      expect(runReasonText(code)).not.toBe(code);
  });
});
