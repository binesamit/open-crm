// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { groupColorHex, t, type Tag } from '@bines/shared';
import { autoFocusSearch, cn, inkOf } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { useTags } from '../board-api';
import { Popover } from './Popover';
import type { CellProps } from './index';
import { SearchClear } from '../../../lib/search-clear';

export const tagColor = (tag: Pick<Tag, 'color'> | undefined) => groupColorHex(tag?.color);

/** A `#name` chip in the tag's colour. */
export const TagChip = ({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) => (
  <span
    className="flex min-w-0 shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal"
    style={{ color: inkOf(tagColor(tag)) }}
  >
    <span className="truncate">#{tag.name}</span>
    {onRemove ? (
      <button type="button" onClick={onRemove} aria-label={tag.name} className="text-muted hover:text-fg">
        ✕
      </button>
    ) : null}
  </span>
);

/**
 * tags (03 §3.1): account-wide tags as `#chips`. Typing searches the account's tags; Enter on a new name creates
 * it (POST /tags) and adds it. Without the tag list (guests) the cell shows its stored text.
 */
export const TagsCell = ({ value, text, editable, onChange, accountId }: CellProps) => {
  const qc = useQueryClient();
  const all = useTags(accountId).data?.data;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const ids = (value as { tag_ids?: string[] } | null)?.tag_ids ?? [];
  const byId = new Map((all ?? []).map((x) => [x.id, x]));
  const query = q.trim().replace(/^#+/, '').trim();
  const shown = (all ?? []).filter((x) => x.name.toLowerCase().includes(query.toLowerCase()));
  const exact = (all ?? []).find((x) => x.name.toLowerCase() === query.toLowerCase());
  // A tag someone else just created: refresh the list once instead of showing nothing.
  const missing = !!all && ids.some((id) => !byId.has(id));
  useEffect(() => {
    if (missing) void qc.invalidateQueries({ queryKey: ['account', accountId, 'tags'] });
  }, [missing, qc, accountId]);

  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onChange(next.length ? { tag_ids: next } : null);
  };
  const create = async () => {
    if (creating || !query) return;
    setCreating(true);
    try {
      const tag = await api(accountId).post<Tag>('/tags', { name: query });
      await qc.invalidateQueries({ queryKey: ['account', accountId, 'tags'] });
      setQ('');
      if (!ids.includes(tag.id)) onChange({ tag_ids: [...ids, tag.id] });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center px-2 text-sm',
        editable && 'cursor-pointer hover:bg-surface-2',
      )}
      onClick={() => editable && setOpen(true)}
    >
      <span className="flex min-w-0 gap-1 overflow-hidden" data-testid="cell-value">
        {all ? (
          ids.map((id) => (byId.has(id) ? <TagChip key={id} tag={byId.get(id)!} /> : null))
        ) : (
          <span className="truncate">{text}</span>
        )}
      </span>
      <Popover open={open} onClose={() => (setOpen(false), setQ(''))} className="w-64">
        {ids.length ? (
          <div className="mb-2 flex flex-wrap gap-1 border-b border-line pb-2">
            {ids.map((id) =>
              byId.has(id) ? <TagChip key={id} tag={byId.get(id)!} onRemove={() => toggle(id)} /> : null,
            )}
          </div>
        ) : null}
        <div className="relative mb-1">
          <input
            autoFocus={autoFocusSearch()}
            value={q}
            placeholder={t('tags.search')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !query || creating) return;
              if (exact) {
                if (!ids.includes(exact.id)) toggle(exact.id);
                setQ('');
              } else void create();
            }}
            data-testid="tags-input"
            className="w-full rounded border border-line px-2 py-1 text-sm pe-7"
          />
          <SearchClear value={q} onClear={() => setQ('')} testId="tags-search-clear" />
        </div>
        <div className="max-h-56 overflow-auto">
          {shown.map((x) => (
            <label
              key={x.id}
              data-testid="tag-option"
              className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-sm hover:bg-surface-2"
            >
              <input type="checkbox" checked={ids.includes(x.id)} onChange={() => toggle(x.id)} />
              <span className="truncate font-normal" style={{ color: inkOf(tagColor(x)) }}>
                #{x.name}
              </span>
            </label>
          ))}
          {all && !all.length && !query ? <p className="px-2 py-1 text-xs text-muted">{t('tags.none')}</p> : null}
        </div>
        {query && !exact ? (
          <button
            type="button"
            disabled={creating}
            onClick={() => void create()}
            className="w-full truncate rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm text-primary hover:bg-surface-2"
          >
            + {t('tags.create', { name: query })}
          </button>
        ) : null}
      </Popover>
    </div>
  );
};
