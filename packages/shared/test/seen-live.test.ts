// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isRowEvent, mergeSeen, UPDATE_SEEN, type UpdateViewer } from '../src';

const v = (id: string, avatar: string | null = null): UpdateViewer => ({
  id,
  name: id,
  avatar_url: avatar,
  devices: [{ device: 'desktop', user_agent: '', last_seen_at: '2026-10-07T10:00:00.000Z' }],
  last_seen_at: '2026-10-07T10:00:00.000Z',
});

describe('r16seen: live "seen by"', () => {
  it('update.seen is never a row event', () => {
    expect(isRowEvent({ type: UPDATE_SEEN, item_id: 'i', board_id: 'b' })).toBe(false);
  });

  it('puts the newest viewers first, each once, keeps known photos, takes the server count, caps the list', () => {
    const old = { count: 2, users: [v('a', 'photo-a'), v('b')] };
    const merged = mergeSeen(old, { count: 3, users: [v('c'), v('a')] }, 20);
    expect(merged.count).toBe(3);
    expect(merged.users.map((u) => u.id)).toEqual(['c', 'a', 'b']);
    expect(merged.users[1]!.avatar_url).toBe('photo-a');
    // The same event twice changes nothing.
    expect(mergeSeen(merged, { count: 3, users: [v('c'), v('a')] }, 20)).toEqual(merged);
    // Capped preview; the count still has everyone.
    const capped = mergeSeen({ count: 2, users: [v('a'), v('b')] }, { count: 25, users: [v('z')] }, 2);
    expect(capped).toEqual({ count: 25, users: [v('z'), v('a')] });
    // Nothing cached yet.
    expect(mergeSeen(undefined, { count: 1, users: [v('a')] }, 20)).toEqual({ count: 1, users: [v('a')] });
  });
});
