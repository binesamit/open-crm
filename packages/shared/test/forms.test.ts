// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  answered,
  applicableQuestions,
  conditionMet,
  formInputOf,
  formSettingsSchema,
  formUnsupportedReason,
  newQuestionId,
} from '../src';

describe('public forms (M11)', () => {
  it('maps column types to inputs; the rest are unavailable with a reason', () => {
    expect(formInputOf('status')).toBe('choice');
    expect(formInputOf('dropdown')).toBe('multi_choice');
    expect(formInputOf('file')).toBe('files');
    expect(formUnsupportedReason('mirror')).toBe('computed');
    expect(formUnsupportedReason('creation_log')).toBe('computed');
    expect(formUnsupportedReason('board_relation')).toBeNull();
    expect(formInputOf('board_relation')).toBe('relation');
    expect(formUnsupportedReason('tags')).toBe('not_supported');
  });

  it('conditions compare choices by value, text case-insensitively, checkboxes by on/off', () => {
    expect(conditionMet({ question_id: 'a', equals: 2 }, 2)).toBe(true);
    expect(conditionMet({ question_id: 'a', equals: 2 }, '2')).toBe(true);
    expect(conditionMet({ question_id: 'a', equals: 2 }, [1, 2])).toBe(true);
    expect(conditionMet({ question_id: 'a', equals: 'Yes' }, ' yes ')).toBe(true);
    expect(conditionMet({ question_id: 'a', equals: true }, true)).toBe(true);
    expect(conditionMet({ question_id: 'a', equals: false }, undefined)).toBe(true);
    expect(conditionMet({ question_id: 'a', equals: 'x' }, null)).toBe(false);
  });

  it('a question applies only when the one it depends on applies and meets the condition', () => {
    const qs = [
      { id: 'a', condition: null },
      { id: 'b', condition: { question_id: 'a', equals: 1 } },
      { id: 'c', condition: { question_id: 'b', equals: 'go' } },
    ];
    expect(applicableQuestions(qs, { a: 1, b: 'go' }).map((q) => q.id)).toEqual(['a', 'b', 'c']);
    // c's answer is "go" but b does not apply (a ≠ 1): c drops out too.
    expect(applicableQuestions(qs, { a: 2, b: 'go' }).map((q) => q.id)).toEqual(['a']);
  });

  it('answered / ids / settings defaults', () => {
    expect(answered('  ')).toBe(false);
    expect(answered([])).toBe(false);
    expect(answered(false)).toBe(false);
    expect(answered(0)).toBe(true);
    expect(newQuestionId()).toMatch(/^[a-z0-9]{8}$/);
    const s = formSettingsSchema.parse({});
    expect(s).toMatchObject({ language: 'he', allow_embed: false, max_submissions: null, close_at: null });
    expect(formSettingsSchema.safeParse({ redirect_url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
