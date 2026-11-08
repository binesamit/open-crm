// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type Column,
  formatDayMonth,
  formatTime,
  localDateValue,
  type MessageKey,
  type MyWork,
  type MyWorkSettings,
  type StatusLabel,
  t,
  todayIn,
  type WorkBoard,
  type WorkItem,
} from '@bines/shared';
import { Button, cn, Dialog, Notice, Picker, Segmented, SkeletonRows } from '@bines/ui';
import { LabelTag } from '../../lib/label-color';
import { Icon } from '../../lib/icons';
import { api, errorMessage, type Me, type MyAccount } from '../../lib/api';
import { useEventStream } from '../../lib/realtime';
import { useDesktop } from '../../lib/use-desktop';
import { useMembers } from '../board/board-api';
import { BoardAccountContext } from '../board/board-context';
import { CELLS } from '../board/cells';

const workKey = (accountId: string) => ['account', accountId, 'my-work'] as const;
type Patch = {
  hide_done?: boolean;
  group_by?: 'date' | 'board';
  subitems?: boolean;
  boards?: Record<
    string,
    {
      hidden?: boolean;
      date_column?: string | null;
      status_column?: string | null;
      people_column?: string | null;
    } | null
  >;
};

/** Name · board · status · date · people. */
const GRID = 'minmax(12rem,1fr) 10rem 140px 9rem 9rem';

/** A date cell in the short form: "היום", "1 אוק׳" (the year only when it is not this year). */
const dateText = (value: unknown): string | null => {
  const v = value as { date?: string; time?: string } | null;
  if (!v?.date || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return null;
  // a date with a time is the viewer's local day, then the time in the region's format.
  const local = localDateValue({ date: v.date, ...(v.time ? { time: v.time } : {}) });
  const day = local.date === todayIn() ? t('myWork.section.today') : formatDayMonth(local.date);
  return local.time ? `${day} ${formatTime(`${v.date}T${v.time!.slice(0, 5)}:00Z`)}` : day;
};

/** The item's status label (text and colour) on the board's chosen status column. */
const statusOf = (item: WorkItem, board: WorkBoard) => {
  const column = board.status_column;
  if (!column) return null;
  const c = item.cells[column.id];
  const index = (c?.value as { index?: number } | null)?.index;
  if (index == null || !c?.text) return null;
  const label = ((column.settings.labels as StatusLabel[] | undefined) ?? []).find((l) => l.id === index);
  return { text: c.text, color: label?.color ?? null };
};

/**
 * My Work (07 §9.2): every item I or my team are assigned to, by deadline — overdue, today, this week, next
 * week, later, no date — or by board. Status, date and people edit in place (the board's permissions apply).
 * It refreshes when something reaches me on /me/events and when the tab regains focus.
 */
export const MyWorkPage = ({ account, me }: { account: MyAccount; me: Me }) => {
  const qc = useQueryClient();
  const client = api(account.id);
  const key = workKey(account.id);
  const work = useQuery({ queryKey: key, queryFn: () => client.get<MyWork>('/me/work') });
  const members = useMembers(account.id).data?.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  useEventStream('/me/events', account.id, (e) => {
    if (e.type === 'notification.created' || e.type === 'resync') void refresh();
  });
  const settings = useMutation({
    mutationFn: (patch: Patch) => client.patch<MyWorkSettings>('/me/work/settings', patch),
    onSuccess: refresh,
  });
  const setCell = useMutation({
    mutationFn: (v: { itemId: string; column: string; value: unknown }) =>
      client.put(`/items/${v.itemId}/cells/${v.column}`, { value: v.value }),
    onSettled: refresh,
  });
  const desktop = useDesktop();
  const [customizing, setCustomizing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const w = work.data;
  const boards = new Map((w?.boards ?? []).map((b) => [b.id, b]));
  const all = (w?.sections ?? []).flatMap((s) => s.items);
  const groups: { key: string; label: string; items: WorkItem[] }[] = !w
    ? []
    : w.settings.group_by === 'board'
      ? w.boards
          .filter((b) => !b.hidden)
          .map((b) => ({ key: b.id, label: b.name, items: all.filter((i) => i.board_id === b.id) }))
          .filter((g) => g.items.length)
      : w.sections
          .filter((s) => s.items.length)
          .map((s) => ({ key: s.key, label: t(`myWork.section.${s.key}` as MessageKey), items: s.items }));

  const cell = (item: WorkItem, board: WorkBoard, column: Column | null) => {
    if (!column) return <span className="px-2 text-xs text-muted">—</span>;
    const Cell = CELLS[column.type];
    if (!Cell) return null;
    const c = item.cells[column.id];
    return (
      <Cell
        column={column}
        value={c?.value ?? null}
        // Dates in the short Hebrew form ("1 אוק׳", "היום"); everything else as the board shows it.
        // The cell shows text left-to-right: an RTL isolate keeps "1 אוק׳" in Hebrew order.
        text={column.type === 'date' && dateText(c?.value) ? `⁧${dateText(c?.value)}⁩` : (c?.text ?? null)}
        names={c?.names}
        editable={board.can_edit && !column.read_only && !column.restricted_edit}
        onChange={(value) => setCell.mutate({ itemId: item.id, column: column.id, value })}
        members={members}
        accountId={account.id}
        itemId={item.id}
        boardId={board.id}
        canEditSettings={false}
        onSettingsChange={async () => undefined}
      />
    );
  };

  return (
    <BoardAccountContext.Provider value={{ id: account.id, slug: account.slug, meId: me.user.id }}>
      <main className="w-full space-y-4 px-4 py-5 md:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-start">
          <div>
            <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-sm:text-2xl">
              {t('nav.myWork')}
            </h1>
            {w ? <p className="mt-1 text-muted">{t('myWork.count', { n: all.length })}</p> : null}
          </div>
          {w ? (
            <Button variant="secondary" size="sm" data-testid="mywork-customize" onClick={() => setCustomizing(true)}>
              <Icon name="gear" size={14} />
              {t('myWork.customize')}
            </Button>
          ) : null}
        </header>
        {w ? (
          <div className="flex flex-wrap items-center gap-3.5 text-[0.8125rem] text-fg-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="mywork-hide-done"
                checked={w.settings.hide_done}
                onChange={(e) => settings.mutate({ hide_done: e.target.checked })}
                className="size-4 accent-[var(--check)]"
              />
              {t('myWork.hideDone')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="mywork-subitems"
                checked={w.settings.subitems}
                onChange={(e) => settings.mutate({ subitems: e.target.checked })}
                className="size-4 accent-[var(--check)]"
              />
              {t('myWork.subitems')}
            </label>
            <Segmented
              label={t('myWork.groupBy')}
              testId="mywork-group-by"
              className="ms-auto"
              value={w.settings.group_by}
              onChange={(v) => settings.mutate({ group_by: v })}
              options={[
                { value: 'date', label: t('myWork.groupBy.date'), testId: 'mywork-group-by-date' },
                { value: 'board', label: t('myWork.groupBy.board'), testId: 'mywork-group-by-board' },
              ]}
            />
          </div>
        ) : null}

        {work.isError ? <Notice tone="error">{errorMessage(work.error)}</Notice> : null}
        {setCell.isError ? <Notice tone="error">{errorMessage(setCell.error)}</Notice> : null}
        {w?.truncated ? <Notice tone="info">{t('myWork.truncated')}</Notice> : null}
        {!w ? (
          <SkeletonRows rows={6} label={t('app.loading')} />
        ) : !groups.length ? (
          <p
            className="rounded-[var(--radius)] border border-line px-4 py-10 text-center text-sm text-muted"
            data-testid="mywork-empty"
          >
            {t('myWork.empty')}
          </p>
        ) : (
          groups.map((g) => {
            const closed = collapsed.has(g.key);
            const late = g.key === 'past';
            return (
              <section
                key={g.key}
                data-testid="mywork-section"
                data-tour="mywork.list"
                data-key={g.key}
                className="flex flex-col gap-1.5"
              >
                <button
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => toggle(g.key)}
                  className="flex h-[1.875rem] items-center gap-2 self-start"
                >
                  {closed ? (
                    <span aria-hidden className="text-muted">
                      <Icon name="chevronEnd" size={13} strokeWidth={2.4} />
                    </span>
                  ) : null}
                  {/* Like a board group (F4): a colour bar, the title, a count pill. Overdue is red. */}
                  <span aria-hidden className={cn('h-5 w-2 rounded-[4px]', late ? 'bg-danger' : 'bg-accent')} />
                  <span
                    className={cn('font-display text-[1rem] font-extrabold', late ? 'text-danger-fg' : 'text-heading')}
                  >
                    {g.label}
                  </span>
                  <span className="rounded-full bg-surface-2 px-2 py-px text-xs font-normal text-fg-2">
                    {g.items.length}
                  </span>
                </button>
                {closed ? null : desktop ? (
                  <div className="overflow-x-auto rounded-[12px] border border-line">
                    <div
                      className="grid h-9 min-w-[44rem] items-center border-b border-line bg-surface-3 text-xs font-semibold whitespace-nowrap text-muted"
                      style={{ gridTemplateColumns: GRID }}
                    >
                      <span className="px-3">{t('myWork.col.item')}</span>
                      <span className="px-3">{t('myWork.col.board')}</span>
                      <span className="px-3 text-center">{t('myWork.col.status')}</span>
                      <span className="px-3">{t('myWork.col.date')}</span>
                      <span className="px-3">{t('myWork.col.people')}</span>
                    </div>
                    {g.items.map((item) => {
                      const board = boards.get(item.board_id)!;
                      return (
                        <div
                          key={item.id}
                          data-testid="mywork-row"
                          data-item-name={item.name}
                          className="grid h-11 min-w-[44rem] border-b border-line-soft last:border-b-0 hover:bg-surface-2/40"
                          style={{ gridTemplateColumns: GRID }}
                        >
                          <Link
                            to="/a/$accountSlug/b/$boardId/i/$itemId"
                            params={{ accountSlug: account.slug, boardId: board.open_board_id, itemId: item.id }}
                            className="flex min-w-0 items-center gap-2 px-3 text-[0.8125rem] hover:underline"
                            data-parent={item.parent?.name}
                          >
                            {item.parent ? (
                              // A subitem: its parent first, muted (D14).
                              <span
                                className="max-w-[40%] shrink-0 truncate text-xs text-muted"
                                title={item.parent.name}
                              >
                                {item.parent.name} ›
                              </span>
                            ) : null}
                            <span className="truncate font-normal">{item.name}</span>
                          </Link>
                          <Link
                            to="/a/$accountSlug/b/$boardId"
                            params={{ accountSlug: account.slug, boardId: board.open_board_id }}
                            className="flex min-w-0 items-center gap-2 px-3 text-[0.8125rem] text-fg-2 hover:underline"
                          >
                            <Icon name="board" size={15} className="shrink-0 text-muted" />
                            <span className="truncate">{board.name}</span>
                          </Link>
                          <div data-column="status">{cell(item, board, board.status_column)}</div>
                          <div
                            data-column="date"
                            className={cn(late && board.date_column && 'font-normal text-danger-fg')}
                          >
                            {cell(item, board, board.date_column)}
                          </div>
                          <div data-column="people">{cell(item, board, board.people_column)}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  // Phone: each item as a card row in one bordered box (name; status + date at the start, board at the end).
                  <div className="overflow-hidden rounded-[12px] border border-line">
                    {g.items.map((item) => {
                      const board = boards.get(item.board_id)!;
                      const status = statusOf(item, board);
                      const date = board.date_column ? dateText(item.cells[board.date_column.id]?.value) : null;
                      return (
                        <Link
                          key={item.id}
                          to="/a/$accountSlug/b/$boardId/i/$itemId"
                          params={{ accountSlug: account.slug, boardId: board.open_board_id, itemId: item.id }}
                          data-testid="mywork-row"
                          data-item-name={item.name}
                          className="flex flex-col gap-2 border-b border-line-soft bg-surface p-3 last:border-b-0"
                        >
                          <span className="font-normal">
                            {item.parent ? <span className="font-normal text-muted">{item.parent.name} › </span> : null}
                            {item.name}
                          </span>
                          <span className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2">
                              {status ? (
                                <LabelTag color={status.color} className="whitespace-nowrap">
                                  {status.text}
                                </LabelTag>
                              ) : null}
                              {date ? (
                                <span className={cn('text-xs', late ? 'font-normal text-danger-fg' : 'text-muted')}>
                                  {date}
                                </span>
                              ) : null}
                            </span>
                            <span className="truncate text-[0.6875rem] text-muted">{board.name}</span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })
        )}
      </main>
      {w ? (
        <CustomizeDialog
          open={customizing}
          onClose={() => setCustomizing(false)}
          boards={w.boards}
          onChange={(boardId, prefs) => settings.mutate({ boards: { [boardId]: prefs } })}
        />
      ) : null}
    </BoardAccountContext.Provider>
  );
};

/** "התאמה אישית": per board — show or hide, which date, status and people columns count. */
const CustomizeDialog = ({
  open,
  onClose,
  boards,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  boards: WorkBoard[];
  onChange: (
    boardId: string,
    prefs: {
      hidden?: boolean;
      date_column?: string | null;
      status_column?: string | null;
      people_column?: string | null;
    },
  ) => void;
}) => {
  const NONE = '__none__';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('myWork.customize')}
      footer={
        <Button onClick={onClose} data-testid="mywork-customize-close">
          {t('myWork.close')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="mywork-customize-dialog">
        {!boards.length ? <p className="text-sm text-muted">{t('myWork.empty')}</p> : null}
        {boards.map((b) => (
          <div
            key={b.id}
            className="grid grid-cols-[1fr_8rem_8rem_8rem] items-center gap-2"
            data-testid="mywork-board"
            data-name={b.name}
          >
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="mywork-board-show"
                checked={!b.hidden}
                onChange={(e) => onChange(b.id, { hidden: !e.target.checked })}
                className="h-4 w-4 accent-[var(--check)]"
              />
              <span className="truncate">{b.name}</span>
            </label>
            <Picker
              label={`${b.name} — ${t('myWork.dateColumn')}`}
              testId="mywork-board-date"
              value={b.date_column?.id ?? NONE}
              onChange={(v) => onChange(b.id, { date_column: v === NONE ? null : v })}
              options={[
                ...b.date_choices.map((c) => ({ value: c.key, label: c.title })),
                { value: NONE, label: t('myWork.none') },
              ]}
            />
            <Picker
              label={`${b.name} — ${t('myWork.statusColumn')}`}
              testId="mywork-board-status"
              value={b.status_column?.id ?? NONE}
              onChange={(v) => onChange(b.id, { status_column: v === NONE ? null : v })}
              options={[
                ...b.status_choices.map((c) => ({ value: c.key, label: c.title })),
                { value: NONE, label: t('myWork.none') },
              ]}
            />
            <Picker
              label={`${b.name} — ${t('myWork.peopleColumn')}`}
              testId="mywork-board-people"
              value={b.people_choice ?? NONE}
              onChange={(v) => onChange(b.id, { people_column: v === NONE ? null : v })}
              options={[
                { value: NONE, label: t('myWork.anyPeople') },
                ...b.people_choices.map((c) => ({ value: c.key, label: c.title })),
              ]}
            />
          </div>
        ))}
      </div>
    </Dialog>
  );
};
