// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragPendingEvent,
  type DragStartEvent,
  type PointerSensorProps,
} from '@dnd-kit/core';
import { cn } from '@bines/ui';
import type { Item } from '../board-api';

/**
 * Row drag and drop of the table (Fix: ): items, subitems and sub-subitems move with dnd-kit — by the ⋮⋮
 * handle (a few pixels of movement start the drag) or by a long press anywhere on the name cell (held still for
 * `LONG_PRESS_MS`, then the row lifts and follows the pointer). A short click on the name keeps renaming / opening.
 *
 * Drop targets are not dnd-kit droppables (the table is virtual and its rows come and go): every row registers a
 * `DropTarget` under its `data-drop-key`, and the target is the element under the pointer. The drop zone (before /
 * after / into a row, or "the end" of a list) is shown on the target through a tiny store, so only the rows whose
 * zone changes render again.
 */

/** Held this long on the name cell, the row picks up. */
export const LONG_PRESS_MS = 350;
/** Moving further than this while holding is a text selection or a scroll, not a long press. */
const LONG_PRESS_TOLERANCE = 6;
/** The handle starts a drag after this much movement. */
const HANDLE_DISTANCE = 4;
/** Over the middle of a sibling this long, a dragged subitem goes into it instead of beside it. */
const DWELL_MS = 650;

export type Dragged = {
  id: string;
  name: string;
  /** A subitem (any level) — otherwise a top-level item. */
  isSub: boolean;
  parentId: string | null;
  /** Its own subitems (never a drop target) and how many levels hang below it (the board's depth limit). */
  branch: Set<string>;
  height: number;
  /** May land under another parent (needs `item.update`). */
  canReparent: boolean;
  /** The lifted copy's width (the name cell's). */
  width: number;
  /**
   * Fix: — the view is grouped by a column: the section the item was picked up from (dropping it in another
   * one sets that column's value) and the item itself (its current value).
   */
  bucket?: string;
  item?: Item;
  /** a whole group, dragged by its title's handle — it lands only on group titles (`GROUP_DROP`). */
  group?: boolean;
};

/** Drop keys of group titles: only a dragged group lands there, and a dragged group lands nowhere else. */
export const GROUP_DROP = 'grp:';
export const acceptsDrop = (key: string, d: Pick<Dragged, 'group'>) => !!d.group === key.startsWith(GROUP_DROP);

export type Where = 'before' | 'after' | 'inside' | 'end';

export type DropTarget = {
  /**
   * The zone for `d` with the pointer at `y` (0 = the target's top, 1 = its bottom); `dwell` = it has rested on the
   * middle of the target for a while. Null = no drop here.
   */
  zone: (d: Dragged, y: number, dwell: boolean) => Where | null;
  drop: (d: Dragged, where: Where) => void;
};

type DropState = { key: string; where: Where } | null;

type Api = {
  register: (key: string, target: DropTarget) => () => void;
  subscribe: (fn: () => void) => () => void;
  drop: () => DropState;
  pending: () => string | null;
  /** The pointer is over a place the dragged row cannot land (not its own row, not a gap between rows). */
  blocked: () => boolean;
  /** The dragged row's id (null when nothing is dragged). */
  active: string | null;
};

const RowDndContext = createContext<Api | null>(null);

/** What the pointer down on a name cell may start: the handle drags at once, the rest of the cell after a hold. */
class RowSensor extends PointerSensor {
  static override activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent: e }: React.PointerEvent) => {
        if (!e.isPrimary || e.button !== 0) return false;
        const target = e.target as HTMLElement;
        if (target.closest('[data-drag-handle]')) return true;
        // The cell's own controls keep their clicks: check box, arrow, update count, ⋯, "open", the rename field.
        return !target.closest('button, input, textarea, select, a, [contenteditable], [data-no-press]');
      },
    },
  ];

  constructor(props: PointerSensorProps) {
    const handle = !!(props.event.target as HTMLElement | null)?.closest?.('[data-drag-handle]');
    super({
      ...props,
      options: {
        ...props.options,
        activationConstraint: handle
          ? { distance: HANDLE_DISTANCE }
          : { delay: LONG_PRESS_MS, tolerance: LONG_PRESS_TOLERANCE },
      },
    });
  }
}

/** No dnd-kit collisions: the target is the row under the pointer (see `evaluate`). */
const noCollisions: CollisionDetection = () => [];

/**
 * The table's row drag and drop; `onActive` tells the table which row is lifted (it stays rendered), `onGroup` which
 * group is (the table folds every group meanwhile) — null when the drag ends, dropped or cancelled.
 */
export const RowDnd = ({
  children,
  onActive,
  onGroup,
}: {
  children: ReactNode;
  onActive?: (id: string | null) => void;
  onGroup?: (groupId: string | null) => void;
}) => {
  const targets = useRef(new Map<string, DropTarget>());
  const listeners = useRef(new Set<() => void>());
  // The live drag (mutable, read by the event handlers): where the pointer is, what is dragged, where it would land.
  const live = useRef<{
    x: number;
    y: number;
    dragged: Dragged | null;
    drop: DropState;
    pending: string | null;
    blocked: boolean;
    dwell: { key: string; since: number; timer: ReturnType<typeof setTimeout> } | null;
    /** `evaluate` again (the dwell timer, when the pointer rests). */
    again?: () => void;
  }>({ x: 0, y: 0, dragged: null, drop: null, pending: null, blocked: false, dwell: null });
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const sensors = useSensors(useSensor(RowSensor));

  const notify = useCallback(() => listeners.current.forEach((fn) => fn()), []);
  const setDrop = useCallback(
    (next: DropState, blocked = false) => {
      const cur = live.current.drop;
      if (cur?.key === next?.key && cur?.where === next?.where && live.current.blocked === blocked) return;
      live.current.drop = next;
      live.current.blocked = blocked;
      notify();
    },
    [notify],
  );
  const clearDwell = useCallback(() => {
    if (live.current.dwell) clearTimeout(live.current.dwell.timer);
    live.current.dwell = null;
  }, []);

  /** The drop zone under the pointer, for the dragged row. */
  const evaluate = useCallback(() => {
    const s = live.current;
    const d = s.dragged;
    if (!d) return;
    const el = document.elementFromPoint(s.x, s.y)?.closest<HTMLElement>('[data-drop-key]');
    const key = el?.dataset.dropKey;
    const target = key ? targets.current.get(key) : undefined;
    if (!el || !key || !target) {
      clearDwell();
      return setDrop(null);
    }
    const r = el.getBoundingClientRect();
    const y = r.height ? Math.min(1, Math.max(0, (s.y - r.top) / r.height)) : 0.5;
    const middle = y > 0.3 && y < 0.7;
    let dwell = false;
    if (!middle) clearDwell();
    else if (s.dwell?.key !== key) {
      clearDwell();
      s.dwell = { key, since: performance.now(), timer: setTimeout(() => s.again?.(), DWELL_MS) };
    } else dwell = performance.now() - s.dwell.since >= DWELL_MS - 20;
    const where = target.zone(d, y, dwell);
    // Its own row (a copy of it in a grouped view: `section|id`) is home, not a "no entry".
    setDrop(where ? { key, where } : null, !where && key !== d.id && !key.endsWith(`|${d.id}`));
  }, [clearDwell, setDrop]);

  useEffect(() => {
    live.current.again = evaluate;
  }, [evaluate]);

  // The pointer, always: the move that starts a drag is not reported to the drag itself, and the drop is decided by
  // where the button goes up. Capture on window runs before dnd-kit's own document listeners.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      live.current.x = e.clientX;
      live.current.y = e.clientY;
      if (live.current.dragged) evaluate();
    };
    const scroll = () => {
      if (live.current.dragged) evaluate();
    };
    window.addEventListener('pointerdown', move, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', move, true);
    document.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', move, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', move, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [evaluate]);

  const setPending = useCallback(
    (id: string | null) => {
      if (live.current.pending === id) return;
      live.current.pending = id;
      notify();
    },
    [notify],
  );

  const finish = useCallback(() => {
    clearDwell();
    live.current.dragged = null;
    setPending(null);
    setDrop(null);
    setDragged(null);
    onActive?.(null);
    onGroup?.(null);
  }, [clearDwell, setPending, setDrop, onActive, onGroup]);

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      const get = (active.data.current as { get?: () => Dragged } | undefined)?.get;
      const d = get?.();
      setPending(null);
      if (!d) return;
      live.current.dragged = d;
      setDragged(d);
      onActive?.(d.id);
      if (d.group) onGroup?.(d.id);
      evaluate();
    },
    [evaluate, onActive, onGroup, setPending],
  );

  const onDragEnd = useCallback(() => {
    const d = live.current.dragged;
    if (d) evaluate();
    const at = live.current.drop;
    const target = at ? targets.current.get(at.key) : undefined;
    finish();
    if (d && at && target) target.drop(d, at.where);
  }, [evaluate, finish]);

  const onDragPending = useCallback(
    ({ id, constraint }: DragPendingEvent) => {
      // Only the long press shows that it is charging (the handle drags at once).
      if ('delay' in constraint) setPending(String(id));
    },
    [setPending],
  );

  const activeId = dragged?.id ?? null;
  const api = useMemo<Api>(
    () => ({
      register: (key, target) => {
        targets.current.set(key, target);
        return () => {
          if (targets.current.get(key) === target) targets.current.delete(key);
        };
      },
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      drop: () => live.current.drop,
      pending: () => live.current.pending,
      blocked: () => live.current.blocked,
      active: activeId,
    }),
    [activeId],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={noCollisions}
      autoScroll={{ threshold: { x: 0.08, y: 0.12 } }}
      onDragPending={onDragPending}
      onDragAbort={() => setPending(null)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
    >
      <RowDndContext.Provider value={api}>{children}</RowDndContext.Provider>
      {/* The lifted row follows the pointer; it never catches the pointer itself (the target is what is under it). */}
      <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
        {dragged ? <Lifted api={api} dragged={dragged} /> : null}
      </DragOverlay>
    </DndContext>
  );
};

/**
 * The lifted row. Over a place it cannot land (Fix: e.g. a date bucket or a formula column's group of a
 * grouped view) it says so — a "no entry" mark, and the not-allowed pointer everywhere until it moves on.
 */
const Lifted = ({ api, dragged }: { api: Api; dragged: Dragged }) => {
  const blocked = useSyncExternalStore(api.subscribe, api.blocked, () => false);
  return (
    <>
      <style>{`body, body * { cursor: ${blocked ? 'not-allowed' : 'grabbing'} !important; }`}</style>
      <div
        data-testid="row-drag-overlay"
        data-blocked={blocked || undefined}
        className={cn(
          'flex h-[var(--row-h,38px)] items-center gap-2 rounded-[var(--radius-sm)] border bg-surface px-3 text-sm shadow-[var(--shadow-pop)]',
          blocked ? 'border-line text-muted' : 'border-primary text-fg',
        )}
        style={{ width: dragged.width }}
      >
        <span aria-hidden className={cn('text-xs', blocked ? 'text-danger-fg' : 'text-muted')}>
          {blocked ? '⊘' : '⠿'}
        </span>
        <span className="truncate">{dragged.name}</span>
      </div>
    </>
  );
};

/** Registers a drop target while mounted; `target` may change on every render (the latest one is used). */
export const useDropTarget = (key: string, target: DropTarget | null) => {
  const api = useContext(RowDndContext);
  const latest = useRef(target);
  useEffect(() => {
    latest.current = target;
  });
  const enabled = !!target;
  const register = api?.register;
  useEffect(() => {
    if (!register || !enabled) return;
    return register(key, {
      zone: (d, y, dwell) => (acceptsDrop(key, d) ? (latest.current?.zone(d, y, dwell) ?? null) : null),
      drop: (d, where) => latest.current?.drop(d, where),
    });
  }, [register, key, enabled]);
};

/** The drop zone shown on the target `key` right now (null = none). */
export const useDropZone = (key: string): Where | null => {
  const api = useContext(RowDndContext);
  return useSyncExternalStore(
    api?.subscribe ?? noopSubscribe,
    () => {
      const d = api?.drop();
      return d && d.key === key ? d.where : null;
    },
    () => null,
  );
};

/** Whether the row `id` is being held down (a long press charging). */
export const usePressing = (id: string): boolean => {
  const api = useContext(RowDndContext);
  return useSyncExternalStore(
    api?.subscribe ?? noopSubscribe,
    () => api?.pending() === id,
    () => false,
  );
};

const noopSubscribe = () => () => undefined;
