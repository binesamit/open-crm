// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { NAME_SOURCE_EXCLUDED_TYPES, t } from '@bines/shared';
import { cn, SearchableList } from '@bines/ui';
import { columnTypeLabel } from '../../../lib/locale';
import type { Column } from '../board-api';
import { Popover } from '../cells/Popover';
import { ColumnTypeGlyph } from '../table/type-glyphs';

/** The columns a name can be built from: all but the name itself and buttons (NAME_SOURCE_EXCLUDED_TYPES). */
export const nameSourceColumns = (columns: Column[]) =>
  columns.filter((c) => !NAME_SOURCE_EXCLUDED_TYPES.includes(c.type));

/**
 * A column picker for the name source (no native select): a trigger that opens a searchable list of the board's
 * columns, each with its type glyph.
 */
export const ColumnPick = ({
  columns,
  onPick,
  trigger,
  testId,
  invalid,
}: {
  columns: Column[];
  onPick: (key: string) => void;
  /** The trigger's content; it is wrapped in a button. */
  trigger: ReactNode;
  testId: string;
  invalid?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const options = nameSourceColumns(columns);
  return (
    <span className="relative inline-flex max-w-full">
      <button
        type="button"
        data-testid={testId}
        data-invalid={invalid || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex h-9 max-w-full items-center gap-2 rounded-[10px] border bg-surface px-2.5 text-sm hover:bg-surface-3',
          invalid ? 'border-danger-fg ring-2 ring-[var(--danger-soft)]' : 'border-line-strong',
        )}
      >
        {trigger}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-72 p-2">
        <SearchableList
          items={options}
          text={(c) => `${c.title} ${columnTypeLabel(c.type)}`}
          testId="name-source-column-search"
        >
          {(shown) => (
            <ul
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
              role="listbox"
              data-testid="name-source-columns"
            >
              {shown.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    data-testid="name-source-column"
                    data-key={c.id}
                    onClick={() => {
                      setOpen(false);
                      onPick(c.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-start text-sm hover:bg-surface-2"
                  >
                    <ColumnTypeGlyph type={c.type} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted">{columnTypeLabel(c.type)}</span>
                  </button>
                </li>
              ))}
              {!shown.length ? <li className="px-2 py-1 text-xs text-muted">{t('board.noResults')}</li> : null}
            </ul>
          )}
        </SearchableList>
      </Popover>
    </span>
  );
};
