// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { textDiff } from './text-diff';

const join = (parts: ReturnType<typeof textDiff>, kinds: string[]) =>
  parts
    .filter((p) => kinds.includes(p.kind))
    .map((p) => p.text)
    .join('');

describe('textDiff', () => {
  it('gives both texts back: before = kept + removed, after = kept + added', () => {
    const before = 'Answer customers.\nBe short.\n';
    const after = 'Answer customers politely.\nBe short and clear.\nSign with your name.\n';
    const parts = textDiff(before, after);
    expect(join(parts, ['same', 'del'])).toBe(before);
    expect(join(parts, ['same', 'add'])).toBe(after);
  });

  it('marks a small change inside a line as words, not the whole line', () => {
    const parts = textDiff('ענה ללקוחות בקצרה', 'ענה ללקוחות בנימוס ובקצרה');
    expect(parts.find((p) => p.kind === 'same')?.text).toContain('ענה ללקוחות');
    expect(join(parts, ['del'])).toBe('בקצרה');
    expect(join(parts, ['add'])).toContain('בנימוס');
  });

  it('an empty before is all added; same texts are all kept', () => {
    expect(textDiff('', 'New text')).toEqual([{ kind: 'add', text: 'New text' }]);
    expect(textDiff('Same\n', 'Same\n')).toEqual([{ kind: 'same', text: 'Same\n' }]);
  });
});
