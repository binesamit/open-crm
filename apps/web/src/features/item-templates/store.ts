// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

/**
 * What the item-templates host shows: one at a time, opened from anywhere — the item menu (row or
 * card), the board's "new item ▾", the empty board — without passing callbacks through every screen.
 */
export type ItemTemplatesView =
  | { kind: 'save'; boardId: string; itemId: string; itemName: string }
  | { kind: 'apply'; boardId: string; templateId?: string; groupId?: string; parentItemId?: string }
  | { kind: 'manage'; boardId: string }
  | { kind: 'edit'; boardId: string; templateId: string | null };

let current: ItemTemplatesView | null = null;
const listeners = new Set<() => void>();
const set = (v: ItemTemplatesView | null) => {
  current = v;
  listeners.forEach((l) => l());
};

export const openItemTemplates = (v: ItemTemplatesView) => set(v);
export const closeItemTemplates = () => set(null);

export const useItemTemplatesView = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
