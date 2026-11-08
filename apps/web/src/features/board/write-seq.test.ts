// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createWriteSeq } from './write-seq';

/** Audit 2026-10-10, web #1: the older of two in-flight writes must not replace the cached row when it lands last. */
describe('createWriteSeq', () => {
  it('only the latest write of an item is current; other items are independent', () => {
    const w = createWriteSeq();
    const first = w.next('a');
    const second = w.next('a');
    const other = w.next('b');
    expect(w.isLatest('a', second)).toBe(true);
    expect(w.isLatest('a', first)).toBe(false); // the status write answered after the text write
    expect(w.isLatest('b', other)).toBe(true);
    expect(w.isLatest('c', 1)).toBe(false);
    const third = w.next('a');
    expect(w.isLatest('a', second)).toBe(false);
    expect(w.isLatest('a', third)).toBe(true);
  });
});
