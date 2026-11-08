// SPDX-License-Identifier: AGPL-3.0-only
import { t, type MenuNode } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import { showToast } from './toast';
import { menuIcon } from './menu-icons';
import { gateMenuEntry, type PlanGate } from './plan-limit';
import { publicWebOrigin } from './public-address';

/**
 * Turns a registry menu (`packages/shared/src/menus`) into `Menu` entries: each `id` gets its handler, and a
 * submenu the registry leaves open gets its items from `slots` (groups, folders, colors…). An id without a
 * handler is a wiring bug — it throws in dev so it cannot slip through silently. `gates` (by id): rows the account's
 * plan may lack — listed, disabled with the upgrade hint when it does (`gateMenuEntry`, test id `menu-<id>`).
 */
export const toMenuEntries = (
  nodes: MenuNode[],
  handlers: Record<string, () => void>,
  slots: Record<string, MenuEntry[]> = {},
  gates: Record<string, PlanGate | undefined> = {},
): MenuEntry[] =>
  nodes.flatMap((n): MenuEntry[] => {
    if (n.kind === 'separator') return [{ kind: 'separator' }];
    if (n.kind === 'submenu') {
      const items = n.items ? toMenuEntries(n.items, handlers, slots, gates) : slots[n.id];
      if (!items?.length) return [];
      return [
        { kind: 'submenu', label: t(n.label), items, icon: menuIcon(n.id), ...(n.testId ? { testId: n.testId } : {}) },
      ];
    }
    const run = handlers[n.id];
    if (!run) {
      if (import.meta.env.DEV) throw new Error(`menu: no handler for "${n.id}"`);
      return [];
    }
    return [
      gateMenuEntry(
        gates[n.id],
        {
          label: t(n.label),
          onSelect: run,
          danger: n.danger,
          shortcut: n.shortcut,
          icon: menuIcon(n.id),
          ...(n.testId ? { testId: n.testId } : {}),
          ...(n.checked !== undefined ? { checked: !!n.checked, disabled: n.checked === null } : {}),
        },
        n.id,
      ),
    ];
  });

/** Clipboard copy with a short confirmation toast. */
export const copyText = (text: string) =>
  void navigator.clipboard?.writeText(text).then(
    () => showToast({ message: t('menu.copied'), seconds: 2 }),
    () => showToast({ message: t('error.generic'), tone: 'error' }),
  );

/** Absolute link to a path inside the app (for "copy link") — on the platform's public address (M11). */
export const appLink = (path: string) => `${publicWebOrigin()}${path}`;
