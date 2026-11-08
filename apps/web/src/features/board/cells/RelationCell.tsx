// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type KeyboardEvent } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  choiceFilterOf,
  groupColorHex,
  paint,
  t,
  type BoardDetail,
  type Item,
  type ItemSearchResult,
  type RelationPickerGrouping,
} from '@bines/shared';
import { autoFocusSearch, cn } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { boardKeys } from '../board-api';
import { BoardAccountContext } from '../board-context';
import type { CellProps } from './index';
import { Popover } from './Popover';
import { RelationChips } from './RelationChips';
import { linkedNames } from './linked-names';
import { type PickerHit, pickerSections } from './relation-sections';
import { SearchClear } from '../../../lib/search-clear';
import { choiceCaption, unmatchedTip, useRelationMatches } from '../relation-filter';

type Hit = PickerHit;
const PAGE = 30;

/**
 * board_relation (03 §2.16, M1.1 #3): chips of linked items — a chip opens that item's card over the current
 * board. The picker lists the target boards' items straight away, filters as you type, creates a new item
 * when nothing matches, and each result can be opened without linking it.
 * r19relfilter: a column with a choice filter offers only matching items ("by …" above the list, "load more");
 * a linked item that no longer matches stays, greyed with ⚠ and a "remove link" button — or hidden behind
 * "+N hidden" when the column shows only matching links.
 */
export const RelationCell = ({
  column,
  value,
  text,
  names: cellNames,
  editable,
  onChange,
  accountId,
  boardId: sourceBoardId,
  exclude,
}: CellProps & {
  /** An item the picker never offers (a dependency's own item). */
  exclude?: string;
}) => {
  const { slug } = useContext(BoardAccountContext);
  const params = useParams({ strict: false }) as { boardId?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(1);
  // several boards — browse one of them (null = all).
  const [onlyBoard, setOnlyBoard] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = (value as { item_ids?: string[] } | null)?.item_ids ?? [];
  const boardIds = (column.settings.board_ids as string[] | undefined) ?? [];
  const multiple = column.settings.allow_multiple !== false;
  // Items picked here, by id: a draft (a popup) has no stored names for them yet.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const names = linkedNames(ids, cellNames, text).map((n, i) => (n === ids[i] ? (picked[n] ?? n) : n));
  const query = q.trim();
  const isRelation = column.type === 'board_relation';
  const filteredOn = (b: string) => isRelation && !!sourceBoardId && !!choiceFilterOf(column.settings, b);

  // The marks: which linked items no longer match the column's filter (for me).
  const matches = useRelationMatches(accountId, isRelation ? sourceBoardId : '', column);
  const unmatched = new Set(matches?.unmatched ?? []);
  const tipLabel = matches?.filters.length === 1 ? matches.filters[0]!.label : null;
  const onlyMatching = isRelation && column.settings.only_matching_in_cell === true;

  const shownBoards = onlyBoard && boardIds.includes(onlyBoard) ? [onlyBoard] : boardIds;
  // A filtered board pages by 30, and so does a board browsed alone; the others show their first 30 by name.
  const pageable = (b: string) => filteredOn(b) || shownBoards.length === 1;
  // One query per board and page.
  const requests = shownBoards.flatMap((b) =>
    (pageable(b) ? Array.from({ length: pages }, (_, i) => i * PAGE) : [0]).map((offset) => ({ b, offset })),
  );
  const results = useQueries({
    queries: requests.map(({ b, offset }) => ({
      queryKey: ['account', accountId, 'board', b, 'search', query, filteredOn(b) ? column.id : '', offset],
      queryFn: () =>
        api(accountId).get<ItemSearchResult>(
          `/boards/${b}/items/search?q=${encodeURIComponent(query)}${
            filteredOn(b)
              ? `&source_board_id=${encodeURIComponent(sourceBoardId)}&column_id=${encodeURIComponent(column.id)}&offset=${offset}`
              : offset
                ? `&offset=${offset}`
                : ''
          }`,
        ),
      enabled: open,
      staleTime: 10_000,
    })),
  });
  // Target board names: labels the results when there are several, and names the "create in" choices.
  const boards = useQueries({
    queries: boardIds.map((b) => ({
      queryKey: boardKeys.board(accountId, b),
      queryFn: () => api(accountId).get<BoardDetail>(`/boards/${b}`),
      enabled: open,
      staleTime: 60_000,
    })),
  });
  const boardName = (id: string) => boards.find((r) => r.data?.id === id)?.data?.name ?? '';
  // Linked items come first (always visible, even beyond the first 30), then the search results.
  const linked: Hit[] = ids
    .map((id, i) => ({ id, name: names[i] ?? id, board_id: '' }))
    .filter((h) => !query || h.name.toLowerCase().includes(query.toLowerCase()));
  const found = results.flatMap((r) => r.data?.data ?? []);
  const hits = [
    ...linked.map((l) => found.find((h) => h.id === l.id) ?? l),
    ...found.filter((h) => !ids.includes(h.id) && h.id !== exclude),
  ].filter((h) => !onlyBoard || !h.board_id || h.board_id === onlyBoard);
  const grouping = (column.settings.picker_group_by as RelationPickerGrouping | undefined) ?? 'board_group';
  const sections = pickerSections(
    hits,
    shownBoards.map((b) => {
      const detail = boards.find((r) => r.data?.id === b)?.data;
      return { id: b, name: detail?.name ?? '', groups: detail?.groups ?? [] };
    }),
    isRelation ? grouping : 'none',
  );
  const loading = results.some((r) => r.isPending);
  const exact = hits.some((h) => h.name.trim() === query);
  const creatable = boards.flatMap((r) => (r.data?.capabilities['item.create'] ? [r.data] : []));
  // r19relfilter: "by …" per filtered board (first page answers carry it), "load more", hidden name matches.
  const firstPages = requests.flatMap((r, i) => (r.offset === 0 ? [{ b: r.b, data: results[i]?.data }] : []));
  const captions = firstPages.flatMap(({ b, data }) => {
    const c = choiceCaption(data?.filter);
    return c ? [boardIds.length > 1 ? `${boardName(b)}: ${c}` : c] : [];
  });
  const lastPages = shownBoards.map((b) => {
    const i = requests.findLastIndex((r) => r.b === b);
    return { b, data: results[i]?.data };
  });
  const more = (d: ItemSearchResult | undefined) => d?.next_offset !== null && d?.next_offset !== undefined;
  const canLoadMore = lastPages.some((p) => pageable(p.b) && more(p.data));
  // Boards that show only their first 30: typing narrows them (a board browsed alone loads more instead).
  const typeForMore = !query && lastPages.some((p) => !pageable(p.b) && more(p.data));
  const hiddenByFilter = firstPages.reduce((n, p) => n + (p.data?.hidden_by_filter ?? 0), 0);
  const anyFiltered = boardIds.some(filteredOn);

  const close = () => {
    setOpen(false);
    setQ('');
    setPages(1);
    setOnlyBoard(null);
    setError(null);
  };
  const toggle = (id: string) => {
    const hit = hits.find((h) => h.id === id);
    if (hit && !ids.includes(id)) setPicked((p) => ({ ...p, [id]: hit.name }));
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : multiple ? [...ids, id] : [id];
    onChange(next.length ? { item_ids: next } : null);
    if (!multiple) close();
  };
  const unlink = (id: string) => {
    const next = ids.filter((x) => x !== id);
    onChange(next.length ? { item_ids: next } : null);
  };
  const openItem = async (itemId: string) => {
    close();
    // The card opens over the current board (ItemCard reads the item's own board for its columns).
    await navigate({
      to: '/a/$accountSlug/b/$boardId/i/$itemId',
      params: { accountSlug: slug, boardId: params.boardId ?? boardIds[0]!, itemId },
    });
  };
  const create = async (boardId: string) => {
    if (busy || !query) return;
    setBusy(true);
    setError(null);
    try {
      const item = await api(accountId).post<Item>(`/boards/${boardId}/items`, { name: query });
      await qc.invalidateQueries({ queryKey: boardKeys.items(accountId, boardId) });
      setQ('');
      setPicked((p) => ({ ...p, [item.id]: item.name }));
      // r19relfilter: the item just made here is linked even if the filter does not offer it (then it is marked).
      onChange({ item_ids: multiple ? [...ids, item.id] : [item.id], new_item_ids: [item.id] });
      if (!multiple) close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !query) return;
    const match = hits.find((h) => h.name.trim() === query);
    if (match) toggle(match.id);
    else if (creatable.length === 1) void create(creatable[0]!.id);
  };

  const chips = ids.map((id, i) => ({ id, name: names[i] ?? id, off: unmatched.has(id) }));
  const shown = onlyMatching ? chips.filter((c) => !c.off) : chips;
  const hiddenCount = chips.length - shown.length;

  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center px-2 text-sm',
        editable && boardIds.length > 0 && 'cursor-pointer hover:bg-surface-2',
      )}
      onClick={() => editable && boardIds.length > 0 && setOpen(true)}
      data-tour="board.relation-cell"
    >
      <RelationChips
        chips={shown}
        maxChars={isRelation ? Number(column.settings.chip_max_chars) || undefined : undefined}
        onOpen={(id) => void openItem(id)}
        unmatchedTip={unmatchedTip(tipLabel)}
        {...(editable ? { onUnlink: unlink } : {})}
        {...(editable && boardIds.length > 0 ? { onAdd: () => setOpen(true) } : {})}
      />
      {hiddenCount ? (
        <span
          className="ms-1 shrink-0 text-xs text-muted"
          data-testid="relation-hidden-count"
          data-tip={unmatchedTip(tipLabel)}
        >
          {t('relfilter.hiddenCount', { n: hiddenCount })}
        </span>
      ) : null}
      <Popover open={open} onClose={close} className="w-80">
        {captions.length ? (
          <p className="mb-1.5 px-1 text-xs text-muted" data-testid="relation-filter-caption">
            {captions.join(' · ')}
          </p>
        ) : null}
        <div className="relative mb-2">
          <input
            autoFocus={autoFocusSearch()}
            placeholder={t('board.searchItems')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPages(1);
            }}
            onKeyDown={onKey}
            className="w-full rounded border border-line px-2 py-1 text-sm pe-7"
          />
          <SearchClear value={q} onClear={() => setQ('')} testId="relation-search-clear" />
        </div>
        {isRelation && boardIds.length > 1 ? (
          <div
            className="mb-2 flex flex-wrap gap-1"
            role="group"
            aria-label={t('relation.boardFilter')}
            data-testid="relation-board-chips"
          >
            {[null, ...boardIds].map((b) => (
              <button
                key={b ?? 'all'}
                type="button"
                aria-pressed={onlyBoard === b}
                data-testid="relation-board-chip"
                onClick={() => {
                  setOnlyBoard(b);
                  setPages(1);
                }}
                className={cn(
                  'inline-flex h-6 max-w-40 items-center truncate rounded-full px-[0.5625rem] text-xs',
                  onlyBoard === b ? 'bg-primary text-on-primary' : 'bg-surface-2 text-fg-2 hover:bg-surface-3',
                )}
              >
                {b ? boardName(b) || '…' : t('relation.allBoards')}
              </button>
            ))}
          </div>
        ) : null}
        <div className="max-h-64 overflow-auto" role="listbox" aria-multiselectable={multiple}>
          {sections.map((sec) => (
            <div key={sec.key} role="group" aria-label={sec.group?.title ?? sec.board?.name}>
              {sec.board ? (
                <p
                  className="sticky top-0 z-[1] bg-surface px-2 pt-1.5 pb-0.5 text-xs text-heading"
                  data-testid="relation-board-header"
                >
                  {sec.board.name}
                </p>
              ) : null}
              {sec.group ? (
                <p
                  className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-xs text-muted"
                  data-testid="relation-group-header"
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: paint(groupColorHex(sec.group.color)) }}
                  />
                  <span className="truncate">{sec.group.title}</span>
                </p>
              ) : null}
              {sec.hits.map((h) => (
                <div key={h.id} className="group flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type={multiple ? 'checkbox' : 'radio'}
                      checked={ids.includes(h.id)}
                      onChange={() => toggle(h.id)}
                    />
                    <span className={cn('truncate', unmatched.has(h.id) && 'text-muted')}>
                      {unmatched.has(h.id) ? (
                        <span aria-hidden data-tip={unmatchedTip(tipLabel)} data-testid="relation-option-unmatched">
                          ⚠{' '}
                        </span>
                      ) : null}
                      {h.name}
                    </span>
                    {boardIds.length > 1 && (!isRelation || grouping === 'none') ? (
                      <span className="shrink-0 text-xs text-muted">{boardName(h.board_id)}</span>
                    ) : null}
                  </label>
                  <button
                    type="button"
                    aria-label={t('relation.openNamed', { name: h.name })}
                    title={t('relation.open')}
                    onClick={() => void openItem(h.id)}
                    className="shrink-0 rounded border border-line px-1.5 text-xs text-muted opacity-0 hover:border-primary hover:text-primary focus:opacity-100 group-hover:opacity-100"
                  >
                    {t('item.open')}
                  </button>
                </div>
              ))}
            </div>
          ))}
          {!hits.length && !loading ? <p className="px-2 py-1 text-xs text-muted">{t('board.noResults')}</p> : null}
          {hiddenByFilter > 0 && !loading ? (
            <p className="px-2 py-1 text-xs text-muted" data-testid="relation-hidden-hint">
              {t('relfilter.hiddenByFilter', { n: hiddenByFilter })}
            </p>
          ) : null}
          {canLoadMore ? (
            <button
              type="button"
              data-testid="relation-load-more"
              onClick={() => setPages((n) => n + 1)}
              className="w-full rounded px-2 py-1 text-start text-xs text-primary hover:bg-surface-2"
            >
              {t('relfilter.loadMore')}
            </button>
          ) : null}
          {typeForMore && !anyFiltered ? (
            <p className="px-2 py-1 text-xs text-muted">{t('relation.typeForMore')}</p>
          ) : null}
        </div>
        {query && !exact
          ? creatable.map((b) => (
              <button
                key={b.id}
                type="button"
                disabled={busy}
                onClick={() => void create(b.id)}
                className="mt-1 w-full truncate rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm text-primary hover:bg-surface-2 disabled:opacity-50"
              >
                +{' '}
                {creatable.length > 1
                  ? t('relation.createIn', { name: query, board: b.name })
                  : t('relation.create', { name: query })}
              </button>
            ))
          : null}
        {error ? <p className="mt-1 px-2 text-xs text-danger-fg">{error}</p> : null}
      </Popover>
    </div>
  );
};
