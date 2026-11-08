// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type CalendarEmptyClick, type ItemSearchResult, t, weekOf } from '@bines/shared';
import { Button, cn, formatIsoDate, Input, Segmented } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import type { BoardDetail, Column, useBoardMutations } from '../board-api';
import { computedNameInfo } from '../name-source/name-source-api';
import { PickerButton } from '../toolbar/parts';

/** The value a day (or a run of days) gives the calendar's column: a date, a timeline, or the week it falls in. */
export const calendarValueFor = (column: Column, from: string, to: string, firstDay: number) =>
  column.type === 'timeline' ? { from, to } : column.type === 'week' ? weekOf(from, firstDay) : { date: from };

/**
 * a click on an empty spot of a calendar day (or a drag across empty days): a new item on that day, or
 * that day for an item that is already on the board — written to the view's date / timeline column. When the view
 * has not chosen its column yet (and the board has more than one), the panel asks for it first and the view takes it
 * (a view change, saved with the view's "save" like any other).
 */
export const CalendarDayPanel = ({
  accountId,
  board,
  column,
  choices,
  askColumn,
  from,
  to,
  firstDay,
  offer,
  mutations: m,
  onPickColumn,
  onDone,
  cells,
  when,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  /** The board's date / timeline / week columns (the view's choice). */
  choices: Column[];
  /** The view has no column of its own yet: show the choice first. */
  askColumn: boolean;
  from: string;
  to: string;
  firstDay: number;
  offer: Exclude<CalendarEmptyClick, 'off'>;
  mutations: ReturnType<typeof useBoardMutations>;
  onPickColumn: (columnId: string) => void;
  onDone: () => void;
  /**
   * a stretch of hours — the cells it writes (the date and its hours, from the view's settings) and how
   * it reads ("Tue 3 Nov · 09:00–10:30"). The column is the view's then; no choice is asked.
   */
  cells?: Record<string, unknown>;
  when?: string;
}) => {
  // A signature's date is its own (signed when) — never a place for an item.
  const columns = choices.filter((c) => c.type !== 'signature');
  const [step, setStep] = useState<'column' | 'item'>(!cells && askColumn && columns.length > 1 ? 'column' : 'item');
  const [target, setTarget] = useState<Column>(column);
  const [tab, setTab] = useState<'new' | 'existing'>(offer === 'existing' ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState(board.groups[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const computed = computedNameInfo(board).computed;
  const written = cells ?? { [target.id]: calendarValueFor(target, from, to, firstDay) };
  const range =
    when ??
    (from === to || target.type !== 'timeline' ? formatIsoDate(from) : `${formatIsoDate(from)} – ${formatIsoDate(to)}`);

  // Items of the board by name (all of them, not only the days on screen).
  const found = useQuery({
    queryKey: ['account', accountId, 'board', board.id, 'calendar-pick', query],
    queryFn: () =>
      api(accountId).get<ItemSearchResult>(`/boards/${board.id}/items/search?q=${encodeURIComponent(query.trim())}`),
    enabled: step === 'item' && tab === 'existing',
  });

  const fail = (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' });
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || (!computed && !name.trim()) || !groupId) return;
    setBusy(true);
    try {
      await m.createItem.mutateAsync({
        ...(computed ? {} : { name: name.trim() }),
        groupId,
        cells: written,
      });
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (itemId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await m.setCells.mutateAsync({ itemId, cells: written });
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'column')
    return (
      <div className="flex w-72 flex-col gap-2" data-testid="calendar-day-columns">
        <p className="text-sm font-semibold">{t('calendar.pick.columnTitle')}</p>
        <p className="text-xs text-muted">{t('calendar.pick.columnHint')}</p>
        <div className="flex flex-col gap-1">
          {columns.map((c) => (
            <button
              key={c.id}
              type="button"
              className="rounded-[10px] border border-line px-3 py-2 text-start text-sm hover:bg-surface-2"
              data-testid={`calendar-day-column-${c.id}`}
              onClick={() => {
                setTarget(c);
                onPickColumn(c.id);
                setStep('item');
              }}
            >
              {c.title}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div className="flex w-80 flex-col gap-2.5" data-testid="calendar-day-panel">
      <p className="text-sm font-semibold">
        {target.title} · <bdi className="font-normal text-fg-2">{range}</bdi>
      </p>
      {offer === 'both' ? (
        <Segmented
          label={t('calendar.pick.title')}
          value={tab}
          onChange={(v) => setTab(v as 'new' | 'existing')}
          testId="calendar-day-tab"
          options={[
            { value: 'new', label: t('calendar.pick.new'), testId: 'calendar-day-tab-new' },
            { value: 'existing', label: t('calendar.pick.existing'), testId: 'calendar-day-tab-existing' },
          ]}
        />
      ) : null}
      {tab === 'new' ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => void create(e)}>
          {computed ? (
            <p className="text-xs text-muted">{t('calendar.pick.computedName')}</p>
          ) : (
            <Input
              autoFocus
              value={name}
              maxLength={255}
              placeholder={t('calendar.pick.name')}
              aria-label={t('calendar.pick.name')}
              onChange={(e) => setName(e.target.value)}
              data-testid="calendar-day-name"
            />
          )}
          {board.groups.length > 1 ? (
            <PickerButton
              menuLabel={t('calendar.pick.group')}
              placeholder={t('calendar.pick.group')}
              label={board.groups.find((g) => g.id === groupId)?.title ?? ''}
              testId="calendar-day-group"
              items={board.groups.map((g) => ({
                label: g.title,
                checked: g.id === groupId,
                onSelect: () => setGroupId(g.id),
              }))}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              busy={busy}
              disabled={!computed && !name.trim()}
              data-testid="calendar-day-create"
            >
              {t('calendar.pick.create')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={query}
            placeholder={t('calendar.pick.search')}
            aria-label={t('calendar.pick.search')}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="calendar-day-search"
          />
          <div
            className="flex max-h-56 flex-col overflow-y-auto"
            role="listbox"
            aria-label={t('calendar.pick.existing')}
          >
            {(found.data?.data ?? []).map((it) => (
              <button
                key={it.id}
                type="button"
                role="option"
                aria-selected={false}
                disabled={busy}
                className={cn('truncate rounded-[8px] px-2.5 py-1.5 text-start text-sm hover:bg-surface-2')}
                data-testid="calendar-day-result"
                onClick={() => void pick(it.id)}
              >
                {it.name}
              </button>
            ))}
            {found.data && !found.data.data.length ? (
              <p className="px-2.5 py-1.5 text-xs text-muted">{t('calendar.pick.none')}</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
