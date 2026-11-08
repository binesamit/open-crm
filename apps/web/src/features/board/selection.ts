// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useCallback, useMemo, useState } from 'react';
import { BULK_MAX_ITEMS } from '@bines/shared';

/**
 * Multi-select on the table (07 §6, 14 §2): checkbox per row and per group, Shift+click = range in view order,
 * Ctrl+A = everything the view shows (capped). Selection is by id; ids that leave the view drop out of it.
 */
export type Selection = {
  ids: string[];
  has: (id: string) => boolean;
  /** `range`: from the last clicked row to this one, in view order. */
  toggle: (id: string, range?: boolean) => void;
  setMany: (ids: string[], on: boolean) => void;
  selectAll: () => void;
  clear: () => void;
  /** More than the cap was asked for (Ctrl+A on a huge view). */
  capped: boolean;
};

/** `cap`: at most this many by Ctrl+A — a windowed board allows more (its batch then runs by query). */
export const useSelection = (order: string[], cap = BULK_MAX_ITEMS): Selection => {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const visible = useMemo(() => new Set(order), [order]);
  // Only what the view still shows counts (a filter change or a delete drops the rest).
  const ids = useMemo(() => [...picked].filter((id) => visible.has(id)), [picked, visible]);
  const live = useMemo(() => new Set(ids), [ids]);

  const toggle = useCallback(
    (id: string, range = false) => {
      setPicked((prev) => {
        const next = new Set(prev);
        const from = anchor ? order.indexOf(anchor) : -1;
        const to = order.indexOf(id);
        if (range && from >= 0 && to >= 0) {
          const on = !prev.has(id);
          for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            if (on) next.add(x);
            else next.delete(x);
          }
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
      setCapped(false);
    },
    [anchor, order],
  );
  const setMany = useCallback((list: string[], on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const x of list) {
        if (on) next.add(x);
        else next.delete(x);
      }
      return next;
    });
  }, []);
  const selectAll = useCallback(() => {
    setPicked(new Set(order.slice(0, cap)));
    setCapped(order.length > cap);
  }, [order, cap]);
  const clear = useCallback(() => {
    setPicked(new Set());
    setAnchor(null);
    setCapped(false);
  }, []);

  return useMemo(
    () => ({ ids, has: (id: string) => live.has(id), toggle, setMany, selectAll, clear, capped }),
    [ids, live, toggle, setMany, selectAll, clear, capped],
  );
};

/** No selection outside the table view (Kanban, Cards, Calendar). */
export const SelectionContext = createContext<Selection | null>(null);
