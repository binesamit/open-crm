// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Numbers the writes in flight per item (audit 2026-10-10, web #1): two edits of one row sent close together
 * (a status, then a text) could be answered out of order, and the older response replaced the whole cached row
 * last — the newer cell showed its old value until a later refetch. A response that is not the item's latest write
 * is not written into the cache; the caller refetches instead.
 */
export const createWriteSeq = () => {
  const seq = new Map<string, number>();
  return {
    /** Registers a new write of `itemId` and returns its number. */
    next: (itemId: string) => {
      const n = (seq.get(itemId) ?? 0) + 1;
      seq.set(itemId, n);
      return n;
    },
    /** True when write `n` is the latest registered for `itemId`. */
    isLatest: (itemId: string, n: number) => seq.get(itemId) === n,
  };
};
