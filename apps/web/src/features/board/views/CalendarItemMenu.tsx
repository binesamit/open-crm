// SPDX-License-Identifier: AGPL-3.0-only
import { t, type MessageKey } from '@bines/shared';
import { Menu, type MenuEntry } from '@bines/ui';
import { useItemMenu } from '../item-menu';
import { menuIcon } from '../../../lib/menu-icons';
import type { BoardDetail, Column, Item, useBoardMutations } from '../board-api';

/** The colours a new "colour" column starts with (its labels — so the calendar paints by them like any status). */
const NEW_COLOR_LABELS: { color: string; key: MessageKey }[] = [
  { color: 'crimson', key: 'calendar.menu.color.red' },
  { color: 'orange', key: 'calendar.menu.color.orange' },
  { color: 'yellow', key: 'calendar.menu.color.yellow' },
  { color: 'green', key: 'calendar.menu.color.green' },
  { color: 'blue', key: 'calendar.menu.color.blue' },
  { color: 'purple', key: 'calendar.menu.color.purple' },
  { color: 'pink', key: 'calendar.menu.color.pink' },
  { color: 'gray', key: 'calendar.menu.color.gray' },
];

/** A status column's label, as its settings store it. */
type Label = { id: number; label: string; color: string; index?: number };

const dot = (color: string) => (
  <i className="block size-3 rounded-full" style={{ backgroundColor: `var(--c-${color})` }} aria-hidden />
);

/** The label id an item has in a status column (its value `{ index }`), or null. */
const labelOf = (item: Item, col: Column): string | null => {
  const v = item.cells[col.id]?.value as { index?: number | string } | null | undefined;
  return v?.index === undefined || v?.index === null ? null : String(v.index);
};

/**
 * Prod (approved canvas, board 1): an item's menu in the calendar — right click, Shift+F10 / the menu key
 * a phone's long press. The board's item menu (14 §1) with the calendar's rows on top: quick edit, a "status"
 * submenu per status column of the board, and "colour" = the labels of the view's colour column (none yet: make
 * one). Writes go through `write` (one undo each).
 */
export const CalendarItemMenu = ({
  board,
  item,
  at,
  mutations,
  colorColumnId,
  onClose,
  onQuickEdit,
  write,
  onCreateColorColumn,
}: {
  board: BoardDetail;
  item: Item;
  /** Where the menu opens; null = closed (its dialogs — move, templates — may still be open). */
  at: { x: number; y: number } | null;
  mutations: ReturnType<typeof useBoardMutations>;
  /** The view's colour column (a status column), if it has one. */
  colorColumnId: string | null;
  onClose: () => void;
  onQuickEdit: () => void;
  write: (item: Item, cells: Record<string, unknown>, message: string) => void;
  /** Whoever may add columns: make a colour column, set it as the view's colour, and paint the item. */
  onCreateColorColumn?: (labels: { color: string; label: string }[], pick: number) => void;
}) => {
  const base = useItemMenu(board, item, mutations);
  const canEdit = !!board.capabilities['item.update'];
  const statusCols = board.columns.filter((c) => c.type === 'status');

  const pickLabel = (col: Column, label: Label | null): MenuEntry => {
    const current = labelOf(item, col);
    return label
      ? {
          label: label.label || t('calendar.menu.noLabel'),
          icon: dot(label.color),
          checked: current === String(label.id),
          onSelect: () =>
            write(
              item,
              { [col.id]: { index: label.id } },
              t('calendar.menu.set', { name: item.name, value: label.label }),
            ),
        }
      : {
          label: t('calendar.menu.clear'),
          disabled: current === null,
          onSelect: () => write(item, { [col.id]: null }, t('calendar.menu.cleared', { name: item.name })),
        };
  };
  const labelsOf = (col: Column) =>
    [...((col.settings.labels ?? []) as Label[])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const submenuFor = (col: Column, label: string, testId: string): MenuEntry => ({
    kind: 'submenu',
    label,
    testId,
    icon: menuIcon('color'),
    items: [...labelsOf(col).map((l) => pickLabel(col, l)), { kind: 'separator' }, pickLabel(col, null)],
  });

  const colorCol = colorColumnId ? board.columns.find((c) => c.id === colorColumnId && c.type === 'status') : null;
  const colorEntry: MenuEntry | null = colorCol
    ? submenuFor(colorCol, t('calendar.menu.color'), 'calendar-menu-color')
    : onCreateColorColumn && board.capabilities['column.create']
      ? {
          kind: 'submenu',
          label: t('calendar.menu.color'),
          icon: menuIcon('color'),
          testId: 'calendar-menu-color',
          items: [
            { kind: 'label', label: t('calendar.menu.color.new') },
            ...NEW_COLOR_LABELS.map((c, i) => ({
              label: t(c.key),
              icon: dot(c.color),
              onSelect: () =>
                onCreateColorColumn(
                  NEW_COLOR_LABELS.map((x) => ({ color: x.color, label: t(x.key) })),
                  i,
                ),
            })),
          ],
        }
      : null;

  const top: MenuEntry[] = [
    {
      label: t('calendar.menu.quickEdit'),
      icon: menuIcon('edit'),
      onSelect: onQuickEdit,
      testId: 'calendar-menu-edit',
    },
    ...(canEdit
      ? ([
          { kind: 'separator' },
          ...statusCols
            .filter((c) => c.id !== colorCol?.id)
            .map((c) => submenuFor(c, t('calendar.menu.status', { name: c.title }), `calendar-menu-status-${c.id}`)),
          ...(colorEntry ? [colorEntry] : []),
        ] as MenuEntry[])
      : []),
    { kind: 'separator' },
  ];

  return (
    <>
      <Menu at={at} onClose={onClose} items={[...top, ...base.entries]} label={base.label} />
      {base.dialogs}
    </>
  );
};

/** Labels for a new colour column, in the shape a status column's settings take. */
export const colorLabels = (labels: { color: string; label: string }[]): Label[] =>
  labels.map((l, i) => ({ id: i + 1, label: l.label, color: l.color, index: i }));
