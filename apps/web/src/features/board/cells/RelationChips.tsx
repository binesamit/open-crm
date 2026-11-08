// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { Popover } from './Popover';

export type RelationChip = { id: string; name: string; off?: boolean };

const GAP = 4;
const CHIP = 'shrink-0 max-w-[14rem] truncate rounded-full px-2 py-0.5 text-xs font-normal whitespace-nowrap';

/** A name cut to the column's "up to X characters" (0 / unset = by the cell's width only). */
export const chipLabel = (name: string, maxChars?: number) =>
  maxChars && maxChars > 0 && [...name].length > maxChars ? `${[...name].slice(0, maxChars).join('')}…` : name;

/**
 * How many chips fit in `width`, keeping room for the "+N" chip when some are left out: at least one (it then
 * shrinks and cuts its name). Zero width (not laid out yet) shows them all.
 */
export const chipsThatFit = (widths: number[], plus: number, width: number) => {
  if (!width || !widths.length) return widths.length;
  let used = 0;
  for (let k = 0; k < widths.length; k++) {
    used += widths[k]! + (k ? GAP : 0);
    const rest = k + 1 < widths.length ? GAP + plus : 0;
    if (used + rest > width) return Math.max(1, k);
  }
  return widths.length;
};

/**
 * Prod (product owner: "up to X characters, then '+X', a click opens the list"): the linked items of a relation
 * cell as whole chips — as many as the cell's width holds (each name up to the column's max characters), then a
 * "+N" chip that opens the full list: open each item, remove a link, add one. One look for the table, the item
 * card and the cards of Kanban / Cards views.
 */
export const RelationChips = ({
  chips,
  maxChars,
  onOpen,
  onUnlink,
  onAdd,
  unmatchedTip,
}: {
  chips: RelationChip[];
  maxChars?: number;
  onOpen: (id: string) => void;
  /** Editable: removes one link (the list's ×, and an unmatched chip's ×). */
  onUnlink?: (id: string) => void;
  /** Editable: opens the picker (the list's "add"). */
  onAdd?: () => void;
  /** The tip of a linked item that no longer matches the column's filter (r19relfilter). */
  unmatchedTip?: string;
}) => {
  const box = useRef<HTMLSpanElement>(null);
  const plus = useRef<HTMLSpanElement>(null);
  const widths = useRef<number[]>([]);
  const key = chips.map((c) => `${c.id}:${c.name}:${c.off ? 1 : 0}`).join('|') + `#${maxChars ?? 0}`;
  // A new value renders every chip once (measured below, before paint); then only the ones that fit.
  const [placed, setPlaced] = useState({ key: '', fit: chips.length });
  const fit = placed.key === key ? placed.fit : chips.length;
  const [list, setList] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    widths.current = [...el.querySelectorAll<HTMLElement>(':scope > [data-chip]')].map((c) => c.offsetWidth);
    const place = () =>
      setPlaced({ key, fit: chipsThatFit(widths.current, plus.current?.offsetWidth ?? 0, el.clientWidth) });
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);

  const shown = chips.slice(0, fit);
  const more = chips.length - shown.length;
  // Prod round 2 (product owner: "one or two that reach the column's end by themselves should end in '…'"): the
  // last chip shown may shrink and end in "…" — then its tip is the full name.
  const [cut, setCut] = useState<string | null>(null);
  useLayoutEffect(() => {
    const last = box.current?.querySelector<HTMLElement>(':scope > [data-chip][data-last]');
    const truncated = last && last.scrollWidth > last.clientWidth + 1 ? (last.dataset.id ?? null) : null;
    if (truncated !== cut) setCut(truncated);
    // `placed` changes on every placement (a new value, a resize — ResizeObserver sets it again).
  }, [placed, cut]);
  const tip = (c: RelationChip) =>
    c.off ? unmatchedTip : chipLabel(c.name, maxChars) !== c.name || cut === c.id ? c.name : undefined;
  const chip = (c: RelationChip, i: number) => {
    // Not while measuring (every chip at its full width).
    const last = placed.key === key && i === shown.length - 1;
    const label = chipLabel(c.name, maxChars);
    return c.off ? (
      <span
        key={c.id}
        data-chip
        data-id={c.id}
        data-last={last || undefined}
        data-testid="relation-chip-unmatched"
        data-tip={unmatchedTip}
        className={cn(CHIP, 'flex items-center gap-0.5 bg-surface-2 text-muted', last && 'min-w-0 shrink')}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(c.id);
          }}
          className="truncate hover:underline"
        >
          <span aria-hidden>⚠ </span>
          {label}
        </button>
        {onUnlink ? (
          <button
            type="button"
            data-testid="relation-unlink"
            aria-label={t('relfilter.removeLink')}
            data-tip={t('relfilter.removeLink')}
            onClick={(e) => {
              e.stopPropagation();
              onUnlink(c.id);
            }}
            className="shrink-0 rounded-full px-1 hover:bg-surface-3 hover:text-fg"
          >
            ×
          </button>
        ) : null}
      </span>
    ) : (
      <button
        key={c.id}
        type="button"
        data-chip
        data-id={c.id}
        data-last={last || undefined}
        data-testid="relation-chip"
        data-index={i}
        data-tip={tip(c) ?? t('relation.open')}
        aria-label={t('relation.openNamed', { name: c.name })}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(c.id);
        }}
        className={cn(CHIP, 'bg-primary-soft text-primary hover:underline', last && 'min-w-0 shrink')}
      >
        {label}
      </button>
    );
  };

  return (
    <span
      ref={box}
      className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      data-testid="cell-value"
    >
      {/* The widest "+N", unseen, to keep room for it. */}
      <span
        ref={plus}
        aria-hidden
        dir="ltr"
        className={cn(CHIP, 'pointer-events-none invisible absolute start-0 top-0')}
      >
        +{chips.length}
      </span>
      {shown.map((c, i) => chip(c, i))}
      {more > 0 ? (
        <button
          type="button"
          data-testid="relation-more"
          // "+3", never "3+" in a right-to-left line.
          dir="ltr"
          aria-haspopup="dialog"
          aria-expanded={list}
          aria-label={t('relation.moreNamed', { n: more })}
          data-tip={t('relation.moreNamed', { n: more })}
          onClick={(e) => {
            e.stopPropagation();
            setList(true);
          }}
          className={cn(CHIP, 'bg-surface-2 text-fg-2 hover:bg-surface-3')}
        >
          +{more}
        </button>
      ) : null}
      <Popover open={list} onClose={() => setList(false)} className="w-72">
        <div role="dialog" aria-label={t('relation.listTitle', { n: chips.length })} data-testid="relation-list">
          <p className="mb-1.5 px-1 text-xs text-muted">{t('relation.listTitle', { n: chips.length })}</p>
          <ul className="max-h-64 space-y-0.5 overflow-auto">
            {chips.map((c) => (
              <li
                key={c.id}
                data-testid="relation-list-row"
                className="group flex items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-surface-2"
              >
                <button
                  type="button"
                  onClick={() => {
                    setList(false);
                    onOpen(c.id);
                  }}
                  data-tip={c.off ? unmatchedTip : t('relation.open')}
                  className={cn('min-w-0 flex-1 truncate text-start hover:underline', c.off && 'text-muted')}
                >
                  {c.off ? <span aria-hidden>⚠ </span> : null}
                  {c.name}
                </button>
                {onUnlink ? (
                  <button
                    type="button"
                    data-testid="relation-list-remove"
                    aria-label={`${t('relfilter.removeLink')}: ${c.name}`}
                    data-tip={t('relfilter.removeLink')}
                    onClick={() => onUnlink(c.id)}
                    className="shrink-0 rounded px-1.5 text-muted hover:bg-surface-3 hover:text-fg"
                  >
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {onAdd ? (
            <button
              type="button"
              data-testid="relation-list-add"
              onClick={() => {
                setList(false);
                onAdd();
              }}
              className="mt-1 w-full rounded px-2 py-1 text-start text-sm text-primary hover:bg-surface-2"
            >
              + {t('relation.add')}
            </button>
          ) : null}
        </div>
      </Popover>
    </span>
  );
};
