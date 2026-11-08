// SPDX-License-Identifier: AGPL-3.0-only
import { useDeferredValue, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { api } from '../../../lib/api';
import type { CellProps } from './index';
import { Popover } from './Popover';

/**
 * Text cell (03 §2.2) with suggestions from the column's existing values (M1.1 #18): typing filters them,
 * ↑/↓ + Enter or a click picks one, anything else stays free text. `settings.suggest: false` turns it off.
 */
export const TextCell = ({ column, value, text, editable, onChange, accountId, boardId }: CellProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const suggest = column.settings.suggest !== false;
  const q = useDeferredValue(draft.trim());

  const values = useQuery({
    queryKey: ['account', accountId, 'board', boardId, 'column-values', column.id, q],
    queryFn: () =>
      api(accountId).get<{ data: { value: string; count: number }[] }>(
        `/boards/${boardId}/columns/${column.id}/values?q=${encodeURIComponent(q)}`,
      ),
    enabled: editing && suggest,
    // Always fresh when editing starts: another row may just have added a value.
    staleTime: 0,
    placeholderData: (prev) => prev,
  });
  const options = (values.data?.data ?? []).map((v) => v.value).filter((v) => v !== draft.trim());
  const open = editing && suggest && !dismissed && options.length > 0;

  // Enter commits and the input unmounts; Chrome then fires `blur` on the removed element, and `value` has not
  // caught up yet (the PUT is in flight) — so one commit per edit (audit 2026-10-10 web #9).
  const committed = useRef(false);
  const commit = (input: string) => {
    if (committed.current) return;
    committed.current = true;
    setEditing(false);
    const next = input.trim() === '' ? null : input.trim();
    if (next !== (value ?? null)) onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      const n = options.length;
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n));
    } else if (e.key === 'Enter') {
      commit(open && active >= 0 ? options[active]! : draft);
    } else if (e.key === 'Escape') {
      // Handled here (the item card stays open — round 13): the list closes first, then the edit is cancelled.
      e.preventDefault();
      if (open) setDismissed(true);
      else setEditing(false);
    }
  };

  if (!editing) {
    return (
      <div
        className={cn(
          'relative flex h-full w-full items-center px-2 text-sm',
          editable && 'cursor-pointer hover:bg-surface-2',
        )}
        onClick={() => {
          if (!editable) return;
          setDraft(typeof value === 'string' ? value : '');
          setActive(-1);
          setDismissed(false);
          committed.current = false;
          setEditing(true);
        }}
      >
        <span className="truncate">{text}</span>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <input
        autoFocus
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(-1);
          setDismissed(false);
        }}
        onKeyDown={onKey}
        onBlur={() => commit(draft)}
        className="h-full w-full border-2 border-primary bg-surface px-2 text-sm outline-none"
      />
      <Popover open={open} onClose={() => setDismissed(true)} className="w-60 p-1">
        <p className="px-2 pb-1 text-[0.6875rem] text-muted">{t('cell.suggestions')}</p>
        <ul id={listId} role="listbox" aria-label={t('cell.suggestions')}>
          {options.map((o, i) => (
            <li
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: picking must not blur (and commit) the input first.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'cursor-pointer truncate rounded-[var(--radius-sm)] px-2 py-1 text-sm',
                i === active ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2',
              )}
            >
              {o}
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
};
