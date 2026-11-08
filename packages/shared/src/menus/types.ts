// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageKey } from '../i18n';
import type { BoardAction } from '../permissions/board';

/**
 * Menu registry (14-CONTEXT-MENUS §16). Each entity's builder returns the items the actor may use — an item
 * without permission is left out, never shown disabled. The UI maps `id` to a handler; a submenu without
 * `items` is filled by the UI (lists only it knows: groups, folders, colors, column types).
 */
export type MenuNode =
  | {
      kind: 'action';
      id: string;
      label: MessageKey;
      shortcut?: string;
      danger?: boolean;
      /** A toggle shown with a checkmark; `null` = state not known yet (shown disabled, so nothing shifts). */
      checked?: boolean | null;
      /** The row's `data-testid` (an entry shared by several menus keeps one id). */
      testId?: string;
    }
  | { kind: 'submenu'; id: string; label: MessageKey; items?: MenuNode[]; testId?: string }
  | { kind: 'separator' };

/** Board capabilities as sent in `GET /boards/:id` (`capabilities`). */
export type BoardCaps = Partial<Record<BoardAction, boolean>>;

export const action = (
  id: string,
  label: MessageKey,
  opts: { shortcut?: string; danger?: boolean; checked?: boolean | null; testId?: string } = {},
): MenuNode => ({ kind: 'action', id, label, ...opts });

export const submenu = (
  id: string,
  label: MessageKey,
  items?: MenuNode[],
  opts: { testId?: string } = {},
): MenuNode => ({
  kind: 'submenu',
  id,
  label,
  ...(items ? { items } : {}),
  ...opts,
});

export const SEP: MenuNode = { kind: 'separator' };

/** Drops `false`/`null` entries and separators that would lead, trail or double up. */
export const menu = (entries: (MenuNode | false | null | undefined)[]): MenuNode[] => {
  const out: MenuNode[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.kind === 'separator' && (!out.length || out.at(-1)!.kind === 'separator')) continue;
    out.push(e);
  }
  while (out.at(-1)?.kind === 'separator') out.pop();
  return out;
};

/** `id`s of a menu, nested ones as `parent>child` — what the snapshot tests compare (14 §16). */
export const menuIds = (nodes: MenuNode[]): string[] =>
  nodes.flatMap((n) =>
    n.kind === 'separator'
      ? ['—']
      : n.kind === 'submenu'
        ? [`${n.id}▸`, ...menuIds(n.items ?? []).map((c) => `${n.id}>${c}`)]
        : [n.danger ? `${n.id}!` : n.id],
  );
