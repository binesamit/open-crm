// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  findUpdateThread,
  isUpdateLinkId,
  updateLinkQuery,
  updateLinkSearch,
  withUpdateLink,
  withoutUpdateLink,
} from '../src';

const U1 = '01JAAAAAAAAAAAAAAAAAAAAAA1';
const U2 = '01JAAAAAAAAAAAAAAAAAAAAAA2';
const R1 = '01JAAAAAAAAAAAAAAAAAAAAAR1';
const R2 = '01JAAAAAAAAAAAAAAAAAAAAAR2';
const updates = [
  { id: U1, replies: [] },
  { id: U2, replies: [{ id: R1 }, { id: R2 }] },
];

describe('update links (s37reply)', () => {
  it('opens the updates tab on the update', () => {
    expect(updateLinkSearch(R1)).toEqual({ tab: 'updates', update: R1 });
    expect(updateLinkQuery(R1)).toBe(`?tab=updates&update=${R1}`);
  });

  it('falls back to the updates tab without a (valid) id', () => {
    expect(updateLinkSearch(null)).toEqual({ tab: 'updates' });
    expect(updateLinkSearch('a b<script>')).toEqual({ tab: 'updates' });
    expect(updateLinkQuery(undefined)).toBe('?tab=updates');
  });

  it('accepts ids, refuses junk', () => {
    expect(isUpdateLinkId(U1)).toBe(true);
    expect(isUpdateLinkId('')).toBe(false);
    expect(isUpdateLinkId(42)).toBe(false);
    expect(isUpdateLinkId('x'.repeat(65))).toBe(false);
    expect(isUpdateLinkId('../x')).toBe(false);
  });

  it('finds the thread of a top update (no anchor)', () => {
    expect(findUpdateThread(updates, U2)).toEqual({ thread: updates[1], reply: null });
    expect(findUpdateThread(updates, U1)?.thread.id).toBe(U1);
  });

  it('finds the parent thread of a reply at any depth and anchors the reply', () => {
    expect(findUpdateThread(updates, R2)).toEqual({ thread: updates[1], reply: R2 });
  });

  it('is null for an update that is not on the item (deleted)', () => {
    expect(findUpdateThread(updates, 'nope')).toBeNull();
    expect(findUpdateThread([], U1)).toBeNull();
  });

  it('switches the card to one thread and keeps the rest of the URL (s37reply2: clicking the time)', () => {
    expect(withUpdateLink({ view: 'v1', q: 'x', tab: 'files' }, R1)).toEqual({
      view: 'v1',
      q: 'x',
      tab: 'updates',
      update: R1,
    });
    expect(withUpdateLink({ tab: 'updates', update: U1 }, U2)).toEqual({ tab: 'updates', update: U2 });
    const prev = { view: 'v1' };
    expect(withUpdateLink(prev, '../x')).toBe(prev);
  });

  it('"all updates" drops only the link', () => {
    expect(withoutUpdateLink({ view: 'v1', tab: 'updates', update: R1 })).toEqual({ view: 'v1', tab: 'updates' });
    expect(withoutUpdateLink({})).toEqual({});
  });
});
