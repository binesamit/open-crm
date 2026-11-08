// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SEARCH_MIN, t, type SearchResult } from '@bines/shared';
import { autoFocusSearch, Button, cn, Dialog, Input } from '@bines/ui';
import { api } from '../../../lib/api';


/** Choose an item to embed (M8 ד2): search by name across the boards I may see. */
export const ItemPickerDialog = ({
  accountId,
  onClose,
  onPick,
}: {
  accountId: string;
  onClose: () => void;
  onPick: (item: { id: string; name: string; board_id: string }) => void;
}) => {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);
  const found = useQuery({
    queryKey: ['account', accountId, 'doc-item-picker', debounced],
    queryFn: () => api(accountId).get<SearchResult>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= SEARCH_MIN,
  });
  const items = found.data?.items ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const pick = items.find((i) => i.id === chosen);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('docs2.embed.pickItem')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!pick}
            data-testid="doc-item-picker-insert"
            onClick={() => {
              if (!pick) return;
              onPick({ id: pick.id, name: pick.name, board_id: pick.board.id });
              onClose();
            }}
          >
            {t('docs2.embed.insert')}
          </Button>
        </>
      }
    >
      <div className="space-y-2" data-testid="doc-item-picker">
        <Input
          autoFocus={autoFocusSearch()}
          value={q}
          placeholder={t('docs2.embed.searchItem')}
          aria-label={t('docs2.embed.searchItem')}
          data-testid="doc-item-picker-search"
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" role="listbox" aria-label={t('docs2.embed.pickItem')}>
          {items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                role="option"
                aria-selected={chosen === i.id}
                data-testid="doc-item-picker-option"
                data-name={i.name}
                onClick={() => setChosen(i.id)}
                onDoubleClick={() => {
                  onPick({ id: i.id, name: i.name, board_id: i.board.id });
                  onClose();
                }}
                className={cn(
                  'flex w-full flex-col items-start rounded-[var(--radius-sm)] px-2.5 py-1.5 text-start',
                  chosen === i.id ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2',
                )}
              >
                <span className="truncate text-sm font-semibold">{i.name}</span>
                <span className="truncate text-xs text-muted">{i.board.name}</span>
              </button>
            </li>
          ))}
          {debounced.length >= SEARCH_MIN && found.isSuccess && !items.length ? (
            <li className="px-2.5 py-2 text-sm text-muted">{t('docs2.embed.noItems')}</li>
          ) : null}
        </ul>
      </div>
    </Dialog>
  );
};
