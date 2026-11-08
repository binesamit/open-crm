// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** F9 cardw: my card width's saves — one request at a time, in order, and no late answer brings back an old width. */
type Answer = { card_width: number | null };
const calls: { body: Answer; resolve: (r: Answer) => void }[] = [];
vi.mock('./api', () => ({
  api: () => ({
    put: (_path: string, body: Answer) => new Promise<Answer>((resolve) => calls.push({ body, resolve })),
  }),
}));
// The store's value, without React: the hook is `useSyncExternalStore(subscribe, () => current)`.
vi.mock('react', async (orig) => ({
  ...(await orig<object>()),
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
}));
const { cardWidthAdopter, saveCardWidth, saveCardWidthSoon, useMyCardWidth } = await import('./card-width');
const useMine = () => useMyCardWidth();
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  calls.length = 0;
  void saveCardWidth(null);
  await flush();
  calls.splice(0).forEach((c) => c.resolve({ card_width: null }));
  await flush();
});

describe('saveCardWidth', () => {
  it('waits for the request in flight; its late answer does not undo the newer save', async () => {
    const first = saveCardWidth(1440);
    await flush();
    const second = saveCardWidth(null);
    await flush();
    expect(calls.map((c) => c.body.card_width)).toEqual([1440]); // the reset waits its turn
    calls[0]!.resolve({ card_width: 1440 });
    await first;
    expect(useMine()).toBeNull();
    await flush();
    expect(calls.map((c) => c.body.card_width)).toEqual([1440, null]);
    calls[1]!.resolve({ card_width: null });
    await second;
    expect(useMine()).toBeNull();
  });

  it('back to back: only the last one is sent', async () => {
    void saveCardWidth(700);
    const last = saveCardWidth(800);
    await flush();
    expect(calls.map((c) => c.body.card_width)).toEqual([800]);
    calls[0]!.resolve({ card_width: 800 });
    await last;
    expect(useMine()).toBe(800);
  });

  it('a save cancels the one waiting for the keys to stop', async () => {
    vi.useFakeTimers();
    try {
      saveCardWidthSoon(672, undefined, 400);
      void saveCardWidth(null);
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(calls.map((c) => c.body.card_width)).toEqual([null]);
    expect(useMine()).toBeNull();
  });

  it("the sign-in GET's answer is ignored when I saved after it went out", async () => {
    const adopt = cardWidthAdopter();
    void saveCardWidth(null);
    adopt({ card_width: 396 });
    expect(useMine()).toBeNull();
    cardWidthAdopter()({ card_width: 500 });
    expect(useMine()).toBe(500);
  });
});
