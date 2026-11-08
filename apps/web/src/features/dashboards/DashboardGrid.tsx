// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DndContext, type DragMoveEvent, PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core';
import {
  clampRect,
  GRID_COLS,
  type GridItem,
  type GridRect,
  mobileOrder,
  placeWidget,
  t,
  type Widget,
  widgetTypes,
} from '@bines/shared';
import { cn } from '@bines/ui';
import { useDesktop } from '../../lib/use-desktop';

/**
 * The dashboard grid (plan §3.4): 12 columns from the inline start (the right in Hebrew), rows of 80px. Owners
 * drag a widget by its handle and resize it by its corner (dnd-kit — react-grid-layout has no RTL); while
 * dragging, the widget snaps to the cells and the others make room, exactly as the server will store it
 * (`placeWidget`). On a phone: one column, top to bottom.
 */
export const ROW_HEIGHT = 80;
const GAP = 12;

export type GridHandles = { moveHandle: ReactNode; resizeHandle: ReactNode };

const MoveHandle = ({ id, label }: { id: string; label: string }) => {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `move:${id}` });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={label}
      title={label}
      data-testid="widget-move"
      className="grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg active:cursor-grabbing"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        {[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
      </svg>
    </button>
  );
};

const ResizeHandle = ({ id, label }: { id: string; label: string }) => {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `resize:${id}` });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={label}
      title={label}
      data-testid="widget-resize"
      className="absolute end-0.5 bottom-0.5 z-[2] grid size-5 cursor-nwse-resize touch-none place-items-center text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rtl:cursor-nesw-resize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="rtl:-scale-x-100">
        <path d="M9 3v6H3M9 6.5 6.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
};

export const DashboardGrid = ({
  widgets,
  editable,
  onLayout,
  render,
}: {
  widgets: Widget[];
  editable: boolean;
  onLayout: (items: GridItem[]) => void;
  render: (w: Widget, handles: GridHandles | null) => ReactNode;
}) => {
  const desktop = useDesktop();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<{ id: string; items: GridItem[] } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [desktop]);

  const base: GridItem[] = widgets.map((w) => ({ id: w.id, rect: w.position }));
  const items = preview?.items ?? base;
  const colW = (width - GAP * (GRID_COLS - 1)) / GRID_COLS;

  /** Where the dragged widget would land for this pointer movement (snapped to the cells). */
  const target = (e: DragMoveEvent): { id: string; rect: GridRect } | null => {
    const [kind, id] = String(e.active.id).split(':') as ['move' | 'resize', string];
    const w = widgets.find((x) => x.id === id);
    if (!w || colW <= 0) return null;
    const rtl = document.documentElement.dir === 'rtl';
    const dCols = Math.round(((rtl ? -1 : 1) * e.delta.x) / (colW + GAP));
    const dRows = Math.round(e.delta.y / (ROW_HEIGHT + GAP));
    const r = w.position;
    const min = widgetTypes.get(w.type)?.minSize;
    const rect =
      kind === 'move'
        ? clampRect({ ...r, x: r.x + dCols, y: r.y + dRows }, min)
        : clampRect({ ...r, w: Math.min(GRID_COLS - r.x, r.w + dCols), h: r.h + dRows }, min);
    return { id, rect };
  };

  const onMove = (e: DragMoveEvent) => {
    const hit = target(e);
    if (!hit) return;
    setPreview({ id: hit.id, items: placeWidget(base, hit.id, hit.rect) });
  };
  const onEnd = (e: DragMoveEvent) => {
    const hit = target(e);
    setPreview(null);
    if (!hit) return;
    const next = placeWidget(base, hit.id, hit.rect);
    const changed = next.some((n) => JSON.stringify(n.rect) !== JSON.stringify(base.find((b) => b.id === n.id)?.rect));
    if (changed) onLayout(next);
  };

  if (!desktop)
    return (
      <div
        className="flex flex-col gap-3"
        data-testid="dashboard-grid"
        data-tour="dashboard.widgets"
        data-layout="stack"
      >
        {mobileOrder(widgets).map((w) => (
          <div key={w.id} style={{ height: Math.max(2, w.position.h) * ROW_HEIGHT }}>
            {render(w, null)}
          </div>
        ))}
      </div>
    );

  const rows = Math.max(1, ...items.map((i) => i.rect.y + i.rect.h));
  const grid = (
    <div
      ref={ref}
      className="relative grid"
      style={{
        gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
        gridAutoRows: `${ROW_HEIGHT}px`,
        gap: GAP,
        minHeight: rows * (ROW_HEIGHT + GAP),
      }}
      data-testid="dashboard-grid"
      data-tour="dashboard.widgets"
      data-layout="grid"
    >
      {widgets.map((w) => {
        const rect = items.find((i) => i.id === w.id)?.rect ?? w.position;
        const dragging = preview?.id === w.id;
        return (
          <div
            key={w.id}
            className={cn('group relative min-w-0 transition-[grid-area]', dragging && 'z-[3] opacity-90')}
            style={{ gridColumn: `${rect.x + 1} / span ${rect.w}`, gridRow: `${rect.y + 1} / span ${rect.h}` }}
            data-testid="dashboard-cell"
            data-widget-id={w.id}
            data-x={rect.x}
            data-y={rect.y}
            data-w={rect.w}
            data-h={rect.h}
          >
            {dragging ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-1 rounded-[18px] border-2 border-dashed border-accent"
              />
            ) : null}
            {render(
              w,
              editable
                ? {
                    moveHandle: <MoveHandle id={w.id} label={t('dashboards.move')} />,
                    resizeHandle: <ResizeHandle id={w.id} label={t('dashboards.resize')} />,
                  }
                : null,
            )}
          </div>
        );
      })}
    </div>
  );
  return editable ? (
    <DndContext sensors={sensors} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={() => setPreview(null)}>
      {grid}
    </DndContext>
  ) : (
    grid
  );
};
