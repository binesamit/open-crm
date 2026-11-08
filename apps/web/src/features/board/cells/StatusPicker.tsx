// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { t, type StatusLabel } from '@bines/shared';
import { tagVars } from '../../../lib/label-color';
import { STATUS_PICKER, statusPickerMove, type StatusPickerLayout } from './status-picker-layout';

/**
 * pal40 — the status picker's body: the column's labels as chips in the cell's own look (11-UI §9.1
 * `.label-tag`: the colour's tint, text in its deep shade, regular weight), flowing down
 * columns of at most eight (`statusPickerLayout`), in a box that scrolls across when the columns are wider than the
 * panel (RTL: the first column on the right) and down when the screen is short; below it the clear option and "edit
 * labels". Keyboard: the current label (else the first) takes the focus; ↑ / ↓ move in a column, ← / → across columns
 * (mirrored in RTL), Home / End, Enter picks (a chip is a button). The panel itself — anchored or floating beside the
 * centre of the viewport — is the cell's `Popover`.
 */
export const StatusPicker = ({
  labels,
  currentId,
  layout,
  onPick,
  onClear,
  footer,
  blocked,
  onPickBlocked,
}: {
  labels: StatusLabel[];
  currentId: number | undefined;
  layout: StatusPickerLayout;
  onPick: (label: StatusLabel) => void;
  onClear: () => void;
  /** The "edit labels" action, when the user may edit them. */
  footer?: ReactNode;
  /**
   * labels the status workflow does not allow from the current one — shown faded; picking one calls
   * `onPickBlocked` (the owner's on-purpose move) when given, else does nothing.
   */
  blocked?: ReadonlySet<number>;
  onPickBlocked?: (label: StatusLabel) => void;
}) => {
  const grid = useRef<HTMLDivElement>(null);
  const { rows, columns } = layout;
  const single = columns === 1;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const chips = [...(grid.current?.querySelectorAll<HTMLButtonElement>('[data-testid="status-option"]') ?? [])];
    const i = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const rtl = getComputedStyle(grid.current!).direction === 'rtl';
    const to = statusPickerMove(i, e.key, chips.length, rows, rtl);
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    chips[to]!.focus({ preventScroll: true });
    chips[to]!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const autofocusId = labels.some((l) => l.id === currentId) ? currentId : labels[0]?.id;
  return (
    <div
      className="flex min-h-0 flex-col gap-1"
      data-testid="status-picker"
      data-columns={columns}
      data-rows={rows}
      data-layout={layout.centred ? 'centre' : 'anchor'}
    >
      <div
        data-testid="status-picker-scroll"
        data-scrolls-across={layout.scrollsAcross || undefined}
        className="status-picker-scroll min-h-0 overflow-auto"
        // Room under the chips for the across scrollbar, so it never sits on a chip.
        style={layout.scrollsAcross ? { paddingBlockEnd: 6 } : undefined}
      >
        <div
          ref={grid}
          role="group"
          aria-label={t('status.picker')}
          title={single ? undefined : t('status.pickerHint')}
          onKeyDown={onKeyDown}
          className="grid grid-flow-col"
          style={{
            gridTemplateRows: `repeat(${rows}, minmax(${STATUS_PICKER.CHIP_HEIGHT}px, auto))`,
            gridAutoColumns: single ? '100%' : `${STATUS_PICKER.COLUMN_WIDTH}px`,
            columnGap: STATUS_PICKER.COLUMN_GAP,
            rowGap: STATUS_PICKER.ROW_GAP,
            width: single ? undefined : layout.contentWidth,
          }}
        >
          {labels.map((l) => {
            const off = !!blocked?.has(l.id);
            return (
              <button
                key={l.id}
                type="button"
                data-testid="status-option"
                data-autofocus={l.id === autofocusId || undefined}
                data-blocked={off || undefined}
                aria-current={l.id === currentId || undefined}
                aria-disabled={(off && !onPickBlocked) || undefined}
                title={off ? t(onPickBlocked ? 'workflow.blockedOverride' : 'workflow.blocked') : undefined}
                onClick={() => (off ? onPickBlocked?.(l) : onPick(l))}
                // The label exactly as the cell shows it: its tint, its ink, regular weight (11-UI §9.1); a move the
                // workflow does not allow is faded.
                className={`label-tag flex min-h-8 w-full rounded-[var(--radius-sm)] px-2 py-1 text-sm ${
                  off
                    ? onPickBlocked
                      ? 'cursor-pointer opacity-40'
                      : 'cursor-not-allowed opacity-40'
                    : 'cursor-pointer hover:opacity-90'
                }`}
                style={tagVars(l.color)}
                data-color={l.color}
              >
                <span className="truncate">{l.label || ' '}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className={single ? 'flex flex-col gap-1' : 'flex items-center gap-2'}>
        <button
          type="button"
          onClick={onClear}
          data-testid="status-clear"
          className="cursor-pointer rounded-[var(--radius-sm)] border border-line px-2 py-1 text-xs text-muted"
          style={single ? undefined : { width: STATUS_PICKER.COLUMN_WIDTH }}
        >
          {t('board.clear')}
        </button>
        {footer}
      </div>
    </div>
  );
};
