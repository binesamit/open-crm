// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { collabClosed, COLLAB_RETRY_AFTER_MS, onCollabClose, type CollabView } from './collab';

/** S-92: what the docs editor does when the server closes the live connection. */
const ctl = () => {
  const patches: Partial<CollabView>[] = [];
  const waits: { fn: () => void; ms: number }[] = [];
  const c = {
    stopReconnect: vi.fn(),
    reconnect: vi.fn(),
    set: (p: Partial<CollabView>) => void patches.push(p),
    later: (fn: () => void, ms: number) => void waits.push({ fn, ms }),
  };
  return { c, patches, waits };
};

describe('collab close codes (S-92)', () => {
  it('maps the server codes; any other close is left to the provider', () => {
    expect(collabClosed(4413)).toBe('too_large');
    expect(collabClosed(4429)).toBe('too_fast');
    expect(collabClosed(1006)).toBeNull();
    expect(collabClosed(undefined)).toBeNull();
  });

  it('4413: stops reconnecting for good and makes the doc read-only', () => {
    const { c, patches, waits } = ctl();
    onCollabClose(4413, c);
    expect(c.stopReconnect).toHaveBeenCalledOnce();
    expect(patches).toEqual([{ closed: 'too_large', readOnly: true }]);
    expect(waits).toEqual([]);
    expect(c.reconnect).not.toHaveBeenCalled();
  });

  it('4429: pauses, tells the person, then reconnects', () => {
    const { c, patches, waits } = ctl();
    onCollabClose(4429, c);
    expect(c.stopReconnect).toHaveBeenCalledOnce();
    expect(patches).toEqual([{ closed: 'too_fast' }]);
    expect(waits).toHaveLength(1);
    expect(waits[0]!.ms).toBe(COLLAB_RETRY_AFTER_MS);
    expect(c.reconnect).not.toHaveBeenCalled();
    waits[0]!.fn();
    expect(c.reconnect).toHaveBeenCalledOnce();
  });

  it('a normal close changes nothing', () => {
    const { c, patches, waits } = ctl();
    onCollabClose(1000, c);
    expect(c.stopReconnect).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(waits).toEqual([]);
  });
});
