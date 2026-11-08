// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { attachedText, promptParts, promptPlain } from './prompt-text';

/** r27: a run's first message without the model's wrapper tags. */
describe('promptParts', () => {
  it('shows the task without <task> tags and the attached item by its source', () => {
    const raw = [
      '<task>',
      'Summarize the lead',
      '</task>',
      '<untrusted_content source="item">',
      '{"item_id":"i1","name":"Dana Levi","board_id":"b1"}',
      '</untrusted_content>',
    ].join('\n');
    const parts = promptParts(raw);
    expect(parts).toEqual([
      { kind: 'text', text: 'Summarize the lead' },
      { kind: 'attached', source: 'item', text: '{"item_id":"i1","name":"Dana Levi","board_id":"b1"}' },
    ]);
    expect(attachedText(parts[1] as Extract<(typeof parts)[number], { kind: 'attached' }>)).toBe('Dana Levi');
    expect(promptPlain(raw)).toBe('Summarize the lead');
    expect(JSON.stringify(parts)).not.toContain('<task>');
  });

  it('keeps a multi-line task and an update as text', () => {
    const raw =
      '<task>\nline 1\nline 2\n</task>\n<untrusted_content source="update">\nhello @agent\n</untrusted_content>';
    expect(promptParts(raw)).toEqual([
      { kind: 'text', text: 'line 1\nline 2' },
      { kind: 'attached', source: 'update', text: 'hello @agent' },
    ]);
  });

  it('leaves text without wrappers as it is', () => {
    expect(promptParts('just a prompt')).toEqual([{ kind: 'text', text: 'just a prompt' }]);
    expect(promptPlain('just a prompt')).toBe('just a prompt');
  });

  it('a non-JSON attached item reads as its text', () => {
    expect(attachedText({ kind: 'attached', source: 'item', text: 'plain' })).toBe('plain');
  });
});
