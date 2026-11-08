// SPDX-License-Identifier: AGPL-3.0-only
import type { SearchResult } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import { mentionAt, refSuggestions } from './ChatRefs';

/** Prod — "@" in the AI chat: what counts as a reference being typed, and the suggestions' order. */
describe('the "@" being typed', () => {
  it('starts at a word start, right before the caret', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('ask @da', 7)).toEqual({ start: 4, query: 'da' });
    expect(mentionAt('ask @דנה', 8)).toEqual({ start: 4, query: 'דנה' });
    // Not inside a word (an email), not after a space, not past the caret.
    expect(mentionAt('mail a@b.com', 12)).toBeNull();
    expect(mentionAt('ask @da now', 11)).toBeNull();
    expect(mentionAt('ask @da now', 7)).toEqual({ start: 4, query: 'da' });
  });
});

describe('suggestions', () => {
  const board = { id: 'b1', name: 'Leads' };
  const result = {
    items: [
      { id: 'i1', name: 'Dana', board, group: null, matched: null, archived: false },
      { id: 'i2', name: 'Old Dana', board, group: null, matched: null, archived: true },
    ],
    boards: [{ ...board, workspace: null }],
    updates: [],
    people: [],
    tags: [],
    files: [],
    docs: [{ id: 'd1', name: 'Plan', workspace: null, excerpt: null }],
    dashboards: [{ id: 'x1', name: 'Sales', workspace: null }],
  } as SearchResult;

  it('items (not archived, with their board), then boards, documents, dashboards', () => {
    expect(refSuggestions(result).map((s) => [s.type, s.id, s.board_id])).toEqual([
      ['item', 'i1', 'b1'],
      ['board', 'b1', null],
      ['doc', 'd1', null],
      ['dashboard', 'x1', null],
    ]);
    expect(refSuggestions(undefined)).toEqual([]);
  });
});
