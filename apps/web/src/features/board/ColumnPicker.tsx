// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { columnTypeLabel } from '../../lib/locale';
import { showToast } from '../../lib/toast';
import { boardKeys, type BoardDetail, type Column } from './board-api';
import { BoardAccountContext } from './board-context';
import { PickerButton } from './toolbar/parts';

/**
 * making the column a setting needs, right where the setting asks for it — for whoever may add columns
 * to the board. `null` = they may not. The board reloads with the new column; the caller takes its id.
 */
export const useCreateColumn = (board: Pick<BoardDetail, 'id' | 'capabilities'>, accountId?: string) => {
  const account = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const id = accountId ?? account.id;
  if (!board.capabilities['column.create'] || !id) return null;
  return async (type: string, title: string, settings?: Record<string, unknown>): Promise<Column> => {
    const col = await api(id).post<Column>(`/boards/${board.id}/columns`, {
      title,
      type,
      ...(settings ? { settings } : {}),
    });
    await qc.invalidateQueries({ queryKey: boardKeys.board(id, board.id) });
    return col;
  };
};

export type CreateColumn = NonNullable<ReturnType<typeof useCreateColumn>>;

/**
 * The menu rows that make a new column of each of `types` ("+ New Hour column") and hand its id on — for any menu that
 * picks a column (view settings, document builders, forms…), so none of them repeats this.
 */
export const createColumnEntries = (
  create: CreateColumn | null | undefined,
  types: readonly string[],
  onCreated: (column: Column) => void,
  opts: {
    title?: (type: string) => string;
    /** Settings the new column starts with (e.g. a timeline "with hours"). */
    settings?: (type: string) => Record<string, unknown> | undefined;
    busy?: (on: boolean) => void;
    testId?: string;
  } = {},
): MenuEntry[] =>
  create && types.length
    ? [
        { kind: 'separator' },
        ...types.map((type): MenuEntry => ({
          label: t('columnPicker.create', { type: columnTypeLabel(type) }),
          testId: opts.testId ? `${opts.testId}-create-${type}` : undefined,
          onSelect: () => {
            opts.busy?.(true);
            create(type, opts.title?.(type) ?? columnTypeLabel(type), opts.settings?.(type))
              .then(onCreated)
              .catch((err: unknown) => showToast({ message: errorMessage(err), tone: 'error' }))
              .finally(() => opts.busy?.(false));
          },
        })),
      ]
    : [];

/**
 * A setting's column: the board's columns that fit, and — when the board allows it — "create a new one" of the
 * types that fit. `leading` rows come first (e.g. "none", "by group").
 */
export const ColumnPicker = ({
  columns,
  value,
  onChange,
  label,
  placeholder,
  menuLabel,
  create,
  createTypes,
  newTitle,
  newSettings,
  leading = [],
  className = 'w-full',
  testId,
}: {
  columns: Column[];
  value: string | null | undefined;
  onChange: (columnId: string) => void;
  /** The button's text when nothing is chosen falls back to `placeholder`; `label` overrides the chosen title. */
  label?: string;
  placeholder?: string;
  menuLabel: string;
  create?: CreateColumn | null;
  /** The types a new column may have (the first ones that fit the setting); none = no "create" rows. */
  createTypes?: readonly string[];
  /** The new column's title (default: its type's name). */
  newTitle?: (type: string) => string;
  newSettings?: (type: string) => Record<string, unknown> | undefined;
  leading?: MenuEntry[];
  className?: string;
  testId?: string;
}) => {
  const [busy, setBusy] = useState(false);
  const current = columns.find((c) => c.id === value);
  return (
    <PickerButton
      label={busy ? t('columnPicker.creating') : (label ?? current?.title)}
      placeholder={placeholder ?? t('filter.column')}
      menuLabel={menuLabel}
      className={className}
      testId={testId}
      items={[
        ...leading,
        ...columns.map((c) => ({
          label: c.title,
          keywords: columnTypeLabel(c.type),
          checked: c.id === current?.id,
          onSelect: () => onChange(c.id),
        })),
        ...createColumnEntries(create, createTypes ?? [], (c) => onChange(c.id), {
          title: newTitle,
          settings: newSettings,
          busy: setBusy,
          testId,
        }),
      ]}
    />
  );
};
