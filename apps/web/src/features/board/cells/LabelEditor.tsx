// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useEffect, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { nextLabelColor, nextLabelId, normalizeLabelColor, t } from '@bines/shared';
import { ColorGrid, tagVars } from '../../../lib/label-color';
import { Button, cn } from '@bines/ui';
import { PopoverSheetContext } from './Popover';
import { LABEL_EDITOR, statusPickerColumnsOf } from './status-picker-layout';

/**
 * Label list editor shared by status and dropdown cells (03 §2.5–2.6, M1.1 #1–2): add, rename, delete,
 * drag to reorder and — for status — pick a colour from the status palette and mark the "done" label.
 * Deleting a label that cells still use is safe: the server keeps it deactivated.
 * c9: status labels are edited in the status picker's own columns (`statusPickerColumnsOf`), so each
 * label sits where it will appear — dragging reorders in reading order (RTL: columns right to left, each top to
 * bottom) and a new label shows at once in the column it will land in. Phones (the sheet) keep the one list, like
 * the picker there; dropdown labels (a plain list when picked) too.
 */
export type EditableLabel = {
  id: number;
  label: string;
  color?: string;
  index?: number;
  is_done?: boolean;
  is_deactivated?: boolean;
};

type Props = {
  labels: EditableLabel[];
  withColor: boolean;
  maxLength: number;
  busy?: boolean;
  /** `leaving`: saved because the editor closed without Save (it is gone already; nothing to close). */
  onSave: (labels: EditableLabel[], opts?: { leaving?: boolean }) => void;
  onCancel: () => void;
};

const Row = ({
  label,
  withColor,
  maxLength,
  fresh,
  onChange,
  onDelete,
}: {
  label: EditableLabel;
  withColor: boolean;
  /** Just added: it takes the focus and is scrolled into view, marked until it is named. */
  fresh?: boolean;
  maxLength: number;
  onChange: (patch: Partial<EditableLabel>) => void;
  onDelete: () => void;
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: label.id,
  });
  const [palette, setPalette] = useState(false);
  // Prod fix (r15board 5): picking a colour keeps the palette open (try another, compare); it folds on a click
  // outside this label, Esc, or its swatch button again.
  const rowRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (fresh) rowRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [fresh]);
  useEffect(() => {
    if (!palette) return;
    const onDown = (e: PointerEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setPalette(false);
    };
    // Esc folds the palette only: on window (capture), ahead of the editor's own popover listener on document,
    // which would close the whole label editor.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPalette(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [palette]);
  return (
    <li
      ref={(el) => {
        setNodeRef(el);
        rowRef.current = el;
      }}
      onKeyDown={(e) => {
        if (palette && e.key === 'Escape') {
          e.stopPropagation();
          setPalette(false);
        }
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded-[var(--radius-sm)] bg-surface',
        fresh && !label.label && 'ring-1 ring-primary',
        isDragging && 'relative z-10 shadow-[var(--shadow-pop)]',
      )}
      data-testid="label-row"
      data-label-id={label.id}
      data-fresh={fresh || undefined}
    >
      <div className="flex items-center gap-1.5 py-0.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('labels.drag')}
          className="cursor-grab px-0.5 text-muted hover:text-fg active:cursor-grabbing"
        >
          ⋮⋮
        </button>
        {withColor ? (
          // The colour button wears the label's real look (the chip's tint, a dot in its ink),.
          <button
            type="button"
            aria-label={t('labels.color')}
            aria-expanded={palette}
            data-testid="label-color"
            onClick={() => setPalette((p) => !p)}
            className="label-tag size-6 shrink-0 rounded-[var(--radius-sm)] p-0 ring-offset-1 hover:ring-2 hover:ring-[var(--tag-ink)]"
            style={tagVars(label.color)}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: 'var(--tag-ink)' }} />
          </button>
        ) : null}
        <input
          value={label.label}
          // A new label: type its name right away.
          autoFocus={fresh}
          maxLength={maxLength}
          aria-label={t('labels.name')}
          placeholder={t('labels.unnamed')}
          onChange={(e) => onChange({ label: e.target.value })}
          // A status label is edited AS the chip it will be: the name field is the chip — the
          // table's tint, its ink, centred, regular weight, the picker's height — so what is typed is what the
          // cell shows. Dropdown labels keep the plain field.
          className={cn(
            'min-w-0 flex-1 rounded-[var(--radius-sm)] text-sm focus:outline-none',
            withColor
              ? 'label-tag h-8 border-0 text-center placeholder:text-[var(--tag-ink)] placeholder:opacity-50 focus:ring-2 focus:ring-[var(--tag-ink)] focus:ring-offset-1 focus:ring-offset-[var(--surface)]'
              : 'h-7 border border-line bg-surface px-2 focus:border-primary',
          )}
          style={withColor ? tagVars(label.color) : undefined}
        />
        {withColor ? (
          <button
            type="button"
            aria-pressed={!!label.is_done}
            title={t('labels.done')}
            aria-label={t('labels.done')}
            onClick={() => onChange({ is_done: !label.is_done })}
            className={cn(
              'rounded-[var(--radius-sm)] px-1 text-sm',
              label.is_done ? 'text-ok-fg' : 'text-[var(--mark-off)] hover:text-muted',
            )}
          >
            ✓
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t('labels.delete')}
          title={t('labels.delete')}
          onClick={onDelete}
          className="px-1 text-muted hover:text-danger-fg"
        >
          ✕
        </button>
      </div>
      {palette ? (
        <ColorGrid
          kind="option"
          look="label"
          label={t('labels.color')}
          testId="label-palette"
          itemTestId="label-swatch"
          className="py-1.5"
          selected={(c) => c === normalizeLabelColor(label.color)}
          onPick={(c) => onChange({ color: c })}
        />
      ) : null}
    </li>
  );
};

export const LabelEditor = ({ labels, withColor, maxLength, busy, onSave, onCancel }: Props) => {
  // Deactivated labels are not edited here; they still count when allocating new ids.
  const [rows, setRows] = useState(() =>
    labels.filter((l) => !l.is_deactivated).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setRows((r) =>
      arrayMove(
        r,
        r.findIndex((l) => l.id === active.id),
        r.findIndex((l) => l.id === over.id),
      ),
    );
  };
  const patch = (id: number, p: Partial<EditableLabel>) =>
    setRows((r) => r.map((l) => (l.id === id ? { ...l, ...p } : p.is_done ? { ...l, is_done: false } : l)));
  const [fresh, setFresh] = useState<number | null>(null);
  const add = () => {
    const id = nextLabelId([...labels, ...rows]);
    // pal40: an unused vivid colour first, then the other families.
    const color = nextLabelColor(rows.map((l) => l.color));
    setRows((r) => [...r, withColor ? { id, label: '', color } : { id, label: '' }]);
    setFresh(id);
  };
  /** What Save sends: the order as `index` (status) and one "done" label at most. */
  const output = (list: EditableLabel[]) =>
    list.map((l, i) => {
      const { is_done, ...rest } = l;
      return withColor ? { ...rest, index: i, ...(is_done ? { is_done: true } : {}) } : rest;
    });
  // leaving the editor without Save (a click outside, Esc, the popover closing) keeps the edits
  // they are saved as Save would, a new label left without a name aside. Only Cancel drops them.
  const latest = useRef(rows);
  const saveRef = useRef(onSave);
  useEffect(() => {
    latest.current = rows;
    saveRef.current = onSave;
  });
  const settled = useRef(false);
  const [initial] = useState(() => JSON.stringify(output(rows)));
  const first = useRef(initial);
  useEffect(
    () => () => {
      if (settled.current) return;
      const known = new Set(labels.map((l) => l.id));
      const next = output(latest.current.filter((l) => known.has(l.id) || l.label.trim()));
      if (JSON.stringify(next) !== first.current) saveRef.current(next, { leaving: true });
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps -- on leaving only; the refs hold the latest edits
  );
  // c9: status labels in the picker's columns; phones (the sheet) and dropdown labels: one list.
  const sheet = useContext(PopoverSheetContext);
  const inColumns = withColor && !sheet;
  const columns = statusPickerColumnsOf(rows, !inColumns);
  const row = (l: EditableLabel) => (
    <Row
      key={l.id}
      label={l}
      withColor={withColor}
      maxLength={maxLength}
      fresh={l.id === fresh}
      onChange={(p) => patch(l.id, p)}
      onDelete={() => setRows((r) => r.filter((x) => x.id !== l.id))}
    />
  );

  return (
    <div
      className={inColumns ? 'w-max max-w-full space-y-2' : 'w-72 space-y-2'}
      data-testid="label-editor"
      data-columns={columns.length}
      data-rows={columns[0]?.length ?? 0}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={rows.map((l) => l.id)}
          strategy={inColumns ? rectSortingStrategy : verticalListSortingStrategy}
        >
          {inColumns ? (
            // The picker's columns side by side (RTL: the first on the right); wider than the screen, they scroll.
            <div
              data-testid="label-editor-scroll"
              className="flex max-h-96 max-w-[calc(100vw-3rem)] items-start overflow-auto"
              style={{ columnGap: LABEL_EDITOR.COLUMN_GAP }}
            >
              {columns.map((column, c) => (
                <ul
                  key={c}
                  data-testid="label-editor-column"
                  className="shrink-0 space-y-0.5"
                  style={{ width: LABEL_EDITOR.COLUMN_WIDTH }}
                >
                  {column.map(row)}
                </ul>
              ))}
            </div>
          ) : (
            <ul className="max-h-72 space-y-0.5 overflow-auto">{rows.map(row)}</ul>
          )}
        </SortableContext>
      </DndContext>
      {inColumns && columns.length > 1 ? <p className="text-xs text-muted">{t('labels.columnsHint')}</p> : null}
      <button
        type="button"
        onClick={add}
        className="w-full rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm text-primary hover:bg-surface-2"
      >
        + {t('labels.add')}
      </button>
      <div className="flex justify-end gap-2 border-t border-line pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            settled.current = true;
            onCancel();
          }}
          data-testid="label-editor-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button
          size="sm"
          busy={busy}
          onClick={() => {
            // Sent: leaving now saves only what changes after this.
            first.current = JSON.stringify(output(rows));
            onSave(output(rows));
          }}
          data-testid="label-editor-save"
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
};
