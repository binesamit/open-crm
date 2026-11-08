// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

/**
 * r16motion (product owner: "a system, not a marketing site — subtle things only"): the small touches that need a line of JS.
 * Everything is gated by `<html data-motion>` in styles.css (lib/appearance.ts sets it), so with animations off or
 * reduced these classes simply do nothing.
 */

const POP_CLASS = 'motion-check-pop';

/**
 * A ticked check box pops once (scale 0.85 → 1, 160ms). Only on a user's change (the `change` event), never when a
 * box is rendered already checked — a board with a thousand checked cells mounts with no animation at all.
 * One listener on the document: no component needs to know.
 */
export const installMotion = () => {
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox' || el.getAttribute('role') === 'switch') return;
      if (!el.checked) return;
      el.classList.remove(POP_CLASS);
      // Restart the animation when ticked again quickly.
      void el.offsetWidth;
      el.classList.add(POP_CLASS);
      el.addEventListener('animationend', () => el.classList.remove(POP_CLASS), { once: true });
    },
    true,
  );
};

/**
 * New rows: an item the user just created gets a soft highlight that fades in ~500ms. The create call marks its id;
 * the row reads the mark when it mounts. A plain mount (scrolling a virtualised board, a refetch) is never marked,
 * so it never animates.
 */
const FRESH_MS = 1500;
const fresh = new Map<string, number>();

export const markFreshItem = (id: string) => {
  fresh.set(id, performance.now());
  // Keep the map tiny: drop old marks.
  for (const [k, at] of fresh) if (performance.now() - at > FRESH_MS) fresh.delete(k);
};

export const isFreshItem = (id: string) => {
  const at = fresh.get(id);
  return at !== undefined && performance.now() - at < FRESH_MS;
};

/** Whether this row shows the "just added" highlight (for its first ~600ms on screen). */
export const useFreshRow = (id: string) => {
  const [on, setOn] = useState(() => isFreshItem(id));
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setOn(false), 600);
    return () => clearTimeout(timer);
  }, [on]);
  return on;
};
